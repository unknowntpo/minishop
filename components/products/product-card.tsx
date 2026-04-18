import Image from "next/image";
import Link from "next/link";

import type { Product } from "@/src/domain/catalog/product";
import { formatProductPrice } from "@/src/presentation/view-models/product";

export function ProductCard({ product }: { product: Product }) {
  return (
    <Link className="product-card" href={`/products/${product.slug}`}>
      <span className="product-card-media">
        <Image
          src={product.image.src}
          alt={product.image.alt}
          width={900}
          height={680}
          sizes="(max-width: 720px) 100vw, (max-width: 1100px) 50vw, 33vw"
        />
      </span>
      <span className="product-card-body">
        <span>
          <span className="product-card-title">{product.name}</span>
          <span className="muted">{product.summary}</span>
        </span>
        <span className="product-card-meta">
          <span>{formatProductPrice(product)}</span>
          <span className="badge neutral">Available {product.available}</span>
        </span>
      </span>
    </Link>
  );
}
