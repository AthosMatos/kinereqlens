// OWNER: ui-shell agent. Shallow-prop memoization for function components (preact core has no memo()).
import { Component, h } from 'preact';
import type { ComponentType, FunctionComponent } from 'preact';

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

/**
 * Wrap a component so it re-renders only when a prop changes by identity (like React.memo). Its own
 * state/context updates still re-render it. Used to keep heavy panes (the editor) from re-rendering
 * whenever an unrelated entry is captured.
 */
export function memo<P extends object>(component: FunctionComponent<P>): ComponentType<P> {
  class Memoized extends Component<P> {
    static override displayName =`Memo(${component.displayName || component.name || 'Component'})`;

    override shouldComponentUpdate(next: Readonly<P>): boolean {
      return !shallowEqual(this.props as Record<string, unknown>, next as Record<string, unknown>);
    }

    override render() {
      return h(component, this.props);
    }
  }
  return Memoized as unknown as ComponentType<P>;
}
