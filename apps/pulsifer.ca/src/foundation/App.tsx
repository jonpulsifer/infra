import React, { useState, useCallback } from 'react';
import {
  Card,
  DisplayText,
  FooterHelp,
  Frame,
  Layout,
  Link,
  Page,
  TextContainer,
  ThemeProvider,
} from '@shopify/polaris';

import {Avatar} from './images';
import {ThingsICareAbout} from '../components';

export function App() {
  const [isDarkTheme, setIsDarkTheme] = useState(true);

  const handleThemeChange = useCallback(
    () => setIsDarkTheme((isDarkTheme) => !isDarkTheme),
    [],
  );

  const darkModeActions = [{
    content: isDarkTheme ? '🌙' : '☀️',
    onAction: handleThemeChange
  }];

  return (
    <ThemeProvider theme={{ colorScheme: isDarkTheme ? 'light' : 'dark' }}>
      <Frame>
        <Page narrowWidth>
          <Layout>
            <Layout.Section>
              <div style={{ margin: 'auto', textAlign: 'center' }}>
                <TextContainer spacing="loose">
                  <img src={Avatar} alt="Avatar" />
                  <DisplayText size="large">hi, i'm @jonpulsifer</DisplayText>
                </TextContainer>
              </div>
            </Layout.Section>
            <Layout.Section>
              <Card title="Find me on the internet" actions={darkModeActions}>
                <Card.Section>
                  <ThingsICareAbout />
                </Card.Section>
              </Card>
            </Layout.Section>
          </Layout>
          <FooterHelp>
            Built with{' '}
            <Link url="https://polaris.shopify.com/">
              Polaris
            </Link>
            .{' '}Hosted on{' '}
            <Link url="https://github.com/homelab-ng/pulsifer.ca">
              GitHub
            </Link>.
          </FooterHelp>
        </Page>
      </Frame>
    </ThemeProvider>
  );
}
