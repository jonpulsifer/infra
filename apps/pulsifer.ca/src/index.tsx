import React from 'react';
import ReactDOM from 'react-dom';
import {AppProvider} from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';
import '@shopify/polaris/dist/styles.css';
import {App} from './foundation';

ReactDOM.render(
  <AppProvider i18n={enTranslations} features={{newDesignLanguage: true}}>
    <App />
  </AppProvider>,
  document.getElementById('root'),
);
