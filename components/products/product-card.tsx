import Image from "next/image";
import Link from "next/link";

import type { Product } from "@/src/domain/catalog/product";
import {
  type BuyerLocale,
  formatBuyerMoney,
  getBuyerMessages,
  getLocalizedProduct,
} from "@/src/presentation/i18n/buyer-localization";

export function ProductCard({ product, locale }: { product: Product; locale: BuyerLocale }) {
  const messages = getBuyerMessages(locale);
  const localizedProduct = getLocalizedProduct(product, locale);

  return (
    <Link className="product-card" href={`/products/${product.slug}`}>
      <span className="product-card-media">
        <Image
          src={localizedProduct.image.src}
          alt={localizedProduct.image.alt}
          width={900}
          height={680}
          sizes="(max-width: 720px) 100vw, (max-width: 1100px) 50vw, 33vw"
        />
      </span>
      <span className="product-card-body">
        <span>
          <span className="product-card-title">
            {localizedProduct.name}
            {product.seckill?.enabled ? (
              <span className="badge warning">{messages.catalogSeckillTag}</span>
            ) : null}
          </span>
          <span className="muted">{localizedProduct.summary}</span>
        </span>
        <span className="product-card-meta">
          <span>{formatBuyerMoney(product.priceAmountMinor, product.currency, locale)}</span>
          <span className="badge neutral">{messages.catalogAvailable(product.available)}</span>
        </span>
      </span>
    </Link>
  );
}
