import { Meteor } from "meteor/meteor";
import { check, Match } from "meteor/check";
import { Products, Catalog as CatalogCollection } from "/lib/collections";
import { Logger, Reaction } from "/server/api";
import { Media } from "/imports/plugins/core/files/server";
import { ProductRevision as Catalog } from "/imports/plugins/core/revisions/server/hooks";

/**
 * isSoldOut
 * @private
 * @summary We are stop accepting new orders if product marked as `isSoldOut`.
 * @param {Array} variants - Array with top-level variants
 * @return {Boolean} true if summary product quantity is zero.
 */
export function isSoldOut(variants) {
  return variants.every((variant) => {
    if (variant.inventoryManagement) {
      return Catalog.getVariantQuantity(variant) <= 0;
    }
    return false;
  });
}

/**
 * isLowQuantity
 * @private
 * @summary If at least one of the variants is less than the threshold, then function returns `true`
 * @param {Array} variants - array of child variants
 * @return {boolean} low quantity or not
 */
export function isLowQuantity(variants) {
  return variants.some((variant) => {
    const quantity = Catalog.getVariantQuantity(variant);
    // we need to keep an eye on `inventoryPolicy` too and qty > 0
    if (variant.inventoryManagement && variant.inventoryPolicy && quantity) {
      return quantity <= variant.lowInventoryWarningThreshold;
    }
    return false;
  });
}

/**
 * isBackorder
 * @private
 * @description Is products variants is still available to be ordered after summary variants quantity is zero
 * @param {Array} variants - array with variant objects
 * @return {boolean} is backorder allowed or not for a product
 */
export function isBackorder(variants) {
  return variants.every((variant) => variant.inventoryPolicy && variant.inventoryManagement &&
    variant.inventoryQuantity === 0);
}


export async function publishProductsToCatalog(productIds) {
  check(productIds, Match.OneOf(String, Array));

  let ids = productIds;
  if (typeof ids === "string") {
    ids = [productIds];
  }

  return ids.every(async (productId) => {
    let product = Products.findOne({
      $or: [
        { _id: productId },
        { ancestors: { $in: [productId] } }
      ]
    });

    if (!product) {
      throw new Meteor.error("error", "Cannot publish product");
    }

    if (Array.isArray(product.ancestors) && product.ancestors.length) {
      product = Products.findOne({
        _id: product.ancestors[0]
      });
    }

    const variants = Products.find({
      ancestors: {
        $in: [productId]
      }
    }).fetch();

    const mediaArray = await Media.find({
      "metadata.productId": productId,
      "metadata.toGrid": 1,
      "metadata.workflow": { $nin: ["archived", "unpublished"] }
    }, {
      sort: { "metadata.priority": 1, "uploadedAt": 1 }
    });

    const productMedia = mediaArray.map((media) => ({
      thumbnail: `${media.url({ store: "thumbnail" })}`,
      small: `${media.url({ store: "small" })}`,
      medium: `${media.url({ store: "medium" })}`,
      large: `${media.url({ store: "large" })}`,
      image: `${media.url({ store: "image" })}`
    }));

    product.variants = variants;
    product.media = productMedia;
    product.type = "product-simple";

    // TODO: Remove these fields in favor of inventory/pricing collection
    product.isSoldOut = isSoldOut(variants);
    product.isBackorder = isBackorder(variants);
    product.isLowQuantity = isLowQuantity(variants);

    // Remove inventory fields
    // delete product.price;
    // delete product.isSoldOut;
    // delete product.isLowQuantity;
    // delete product.isBackorder;

    const result = CatalogCollection.upsert({
      _id: productId
    }, {
      $set: product
    });

    return result && result.numberAffected === 1;
  });
}

Meteor.methods({
  "catalog/publish/products": (productIds) => {
    check(productIds, Match.OneOf(String, Array));

    // Ensure user has createProduct permission for active shop
    if (!Reaction.hasPermission("createProduct")) {
      throw new Meteor.Error("access-denied", "Access Denied");
    }

    // Convert productIds if it's a string
    let ids = productIds;
    if (typeof ids === "string") {
      ids = [productIds];
    }

    // Find all products
    const productsToPublish = Products.find({
      _id: { $in: ids }
    }).fetch();

    if (Array.isArray(productsToPublish)) {
      const canUpdatePrimaryShopProducts = Reaction.hasPermission("createProduct", this.userId, Reaction.getPrimaryShopId());

      const publisableProductIds = productsToPublish
        // Only allow users to publish products for shops they permissions to createProductsFor
        // If the user can createProducts on the main shop, they can publish products for all shops to the catalog.
        .filter((product) => Reaction.hasPermission("createProduct", this.userId, product.shopId) || canUpdatePrimaryShopProducts)
        .map((product) => product._id);

      const success = publishProductsToCatalog(publisableProductIds);

      if (!success) {
        throw new Meteor.Error("server-error", "Some Products could not be published to the Catalog.");
      }

      return true;
    }

    return false;
  }
});