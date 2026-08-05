import { useEffect, useRef, useState } from "react";

interface DrawioImageViewerProps {
  src: string;
  alt?: string;
  className?: string;
  caption?: string;
}

export function DrawioImageViewer({ src, alt = "流程图", className = "", caption }: DrawioImageViewerProps) {
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const positionStart = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open) {
      setScale(1);
      setPosition({ x: 0, y: 0 });
    }
  }, [open]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") setOpen(false);
      if (e.key === "+" || e.key === "=") zoomIn();
      if (e.key === "-") zoomOut();
      if (e.key === "0") resetZoom();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const zoomIn = () => setScale((s) => Math.min(s * 1.2, 8));
  const zoomOut = () => setScale((s) => Math.max(s / 1.2, 0.25));
  const resetZoom = () => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) zoomIn();
    else zoomOut();
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    positionStart.current = { ...position };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPosition({ x: positionStart.current.x + dx, y: positionStart.current.y + dy });
  };

  const onMouseUp = () => setDragging(false);

  return (
    <>
      <figure className={`drawio-thumbnail ${className}`} onClick={() => setOpen(true)}>
        <img src={src} alt={alt} />
        {caption && <figcaption>{caption}</figcaption>}
        <div className="drawio-thumbnail__overlay">
          <span>🔍 点击全屏</span>
        </div>
      </figure>

      {open && (
        <div
          className="drawio-lightbox"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="drawio-lightbox__header">
            <span className="drawio-lightbox__title">{alt}</span>
            <div className="drawio-lightbox__controls">
              <button className="drawio-lightbox__btn" onClick={zoomOut} title="缩小 (-)">−</button>
              <span className="drawio-lightbox__zoom">{Math.round(scale * 100)}%</span>
              <button className="drawio-lightbox__btn" onClick={zoomIn} title="放大 (+)">+</button>
              <button className="drawio-lightbox__btn" onClick={resetZoom} title="重置 (0)">⟲</button>
              <button className="drawio-lightbox__btn drawio-lightbox__btn--close" onClick={() => setOpen(false)} title="关闭 (Esc)">✕</button>
            </div>
          </div>

          <div
            ref={containerRef}
            className={`drawio-lightbox__stage ${dragging ? "drawio-lightbox__stage--dragging" : ""}`}
            onWheel={onWheel}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          >
            <img
              src={src}
              alt={alt}
              style={{
                transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                transformOrigin: "center center",
                cursor: dragging ? "grabbing" : "grab",
              }}
              draggable={false}
            />
          </div>

          <div className="drawio-lightbox__hint">滚轮缩放 · 拖拽平移 · Esc 关闭</div>
        </div>
      )}
    </>
  );
}
