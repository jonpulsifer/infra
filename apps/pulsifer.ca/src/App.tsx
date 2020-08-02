import React, { useState, useCallback } from 'react';
import {
  Card,
  DisplayText,
  Frame,
  Layout,
  Page,
  TextContainer,
  ThemeProvider,
  BaseAction,
} from '@shopify/polaris';

import Avatar from './avatar-250.png';
import ThingsICareAbout from './ThingsICareAbout';

export default function App() {
  const [isDarkTheme, setIsDarkTheme] = useState(false);

  const handleThemeChange = useCallback(
    () => setIsDarkTheme((isDarkTheme) => !isDarkTheme),
    [],
  );

  const darkModeActions: BaseAction[] = [{
    content: isDarkTheme ? '🌙' : '☀️',
    onAction: handleThemeChange
  }];

  return (
    <ThemeProvider theme={{ colorScheme: isDarkTheme ? 'dark' : 'light' }}>
      <Frame>
        <Page narrowWidth>
          <Layout>
            <Layout.Section>
              <div style={{margin: 'auto', textAlign: 'center'}}>
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
        </Page>
      </Frame>
    </ThemeProvider>
  );
}
