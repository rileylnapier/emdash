import { useEffect, useRef } from 'react';
import { mountUpdateControls } from './update-controls';

export function UpdateButton() {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => (element.current ? mountUpdateControls(element.current) : undefined), []);
  return <div ref={element} />;
}
