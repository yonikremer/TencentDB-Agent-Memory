import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './i18n';
// The external version of tea-component@2.8.0 does not have console-pack.css (that is the exclusive Tencent Cloud Console theme package of the internal version),
// Use default-pack.css instead (which includes the Tea Design Token system + default light theme variable definitions).
import 'tea-component/dist/themes/default-pack.css';
import 'tea-component/dist/themes/default-dark.css';
import 'tea-component/dist/tea-themeable.css';
import './index.css';
import './tea-override.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
