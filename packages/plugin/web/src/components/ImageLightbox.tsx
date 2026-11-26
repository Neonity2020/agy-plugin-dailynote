interface ImageLightboxProps {
  src: string | null;
  alt: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  if (!src) return null;

  return (
    <div
      className="dn-modal-backdrop"
      data-testid="dn-lightbox"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt || '图片预览'}
    >
      <img
        src={src}
        alt={alt}
        className="dn-lightbox-img"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
