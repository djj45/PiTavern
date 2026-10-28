import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

/** Retain measured space while keeping expensive message trees near the viewport only. */
export function VirtualRow({ root, initialVisible, children }: {
  root: RefObject<HTMLDivElement | null>; initialVisible: boolean;
  children: (pin: (value: boolean) => void) => ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(initialVisible);
  const [pinned, setPinned] = useState(false);
  const height = useRef(160);
  const mounted = visible || pinned;
  useEffect(() => {
    const node = element.current;
    if (!node || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root: root.current, rootMargin: "800px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [root]);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || !mounted) return;
    const measure = () => { height.current = node.getBoundingClientRect().height || height.current; };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [mounted]);
  return <div ref={element} data-chat-row data-mounted={mounted ? "true" : "false"}
    style={mounted ? undefined : { height: height.current }}>
    {mounted ? children(setPinned) : null}
  </div>;
}
