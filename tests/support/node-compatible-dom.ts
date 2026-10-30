import { JSDOM } from 'jsdom';
import type { Environment } from 'vitest/environments';

/** Initialize browser rendering before dependencies, retaining Node URL, fetch
 * and abort semantics for server modules in the same integration fixture. */
const environment: Environment = {
  name: 'node-compatible-dom',
  viteEnvironment: 'ssr',
  setup(global) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      url: 'https://mitzo.test',
      pretendToBeVisual: true,
    });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const install = (key: string, value: unknown) => {
      originals.set(key, Object.getOwnPropertyDescriptor(global, key));
      Object.defineProperty(global, key, { configurable: true, value, writable: true });
    };
    for (const key of [
      'window',
      'document',
      'navigator',
      'localStorage',
      'sessionStorage',
      'Storage',
      'HTMLElement',
      'HTMLTextAreaElement',
      'HTMLInputElement',
      'Element',
      'Node',
      'MutationObserver',
      'Event',
      'CustomEvent',
      'KeyboardEvent',
      'File',
      'Blob',
      'Image',
    ])
      install(key, Reflect.get(dom.window, key));
    for (const key of [
      'getComputedStyle',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ] as const)
      install(key, dom.window[key].bind(dom.window));
    install('IS_REACT_ACT_ENVIRONMENT', true);
    return {
      teardown() {
        dom.window.close();
        for (const [key, descriptor] of originals) {
          if (descriptor) Object.defineProperty(global, key, descriptor);
          else Reflect.deleteProperty(global, key);
        }
      },
    };
  },
};
export default environment;
