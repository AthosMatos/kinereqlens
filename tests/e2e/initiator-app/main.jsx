// E2E fixture (tests/e2e/initiator.spec.ts): a tiny "React" app — Preact aliased as react / react-dom by the
// spec's esbuild build (source map linked, sourcesContent included).
import { render } from 'react-dom';
import { App } from './App.jsx';

render(<App />, document.getElementById('root'));
