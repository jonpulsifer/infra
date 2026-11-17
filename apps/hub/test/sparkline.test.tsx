import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Sparkline } from '~/components/sparkline';

test('the warmest dot is orange for every station while the curve keeps its accent', () => {
  for (const accent of ['#2A93CC', '#CC7E2F']) {
    const markup = renderToStaticMarkup(
      <Sparkline
        points={[
          [1, 10],
          [2, 20],
          [3, 15],
        ]}
        accent={accent}
        gradientId="temperature"
        label="Temperature over the last 24 hours"
      />,
    );

    expect(markup).toContain(`stroke="${accent}"`);
    expect(markup).toContain('border:2px solid #CC7E2F');
    expect(markup).toContain('border:2px solid #5D7E9B');
  }
});
