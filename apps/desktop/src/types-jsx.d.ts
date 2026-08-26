import type { JSX as ReactJSX } from "react";

// React 19 no longer provides the global JSX namespace; restore the small surface we use.
declare global {
  namespace JSX {
    type Element = ReactJSX.Element;
    type ElementClass = ReactJSX.ElementClass;
    interface IntrinsicElements extends ReactJSX.IntrinsicElements {}
    interface IntrinsicAttributes extends ReactJSX.IntrinsicAttributes {}
  }
}

export {};
