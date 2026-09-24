import { describe, expect, test } from 'bun:test';
import { parseBurnSafe, parseCountyMap } from '~/lib/burnsafe';

// Trimmed from the live page: the markup around each row is what the parser
// depends on, so it is kept as the page serves it.
const PAGE = `
<h1>Fire restrictions</h1>
<p>
  Last updated: 24 September 2026 at 2:00 pm
</p>
<table class="table table-striped" id="restriction-table" width="100%">
<tbody>
  <tr id="Cape-Breton-County">
    <th scope="row">Cape Breton County</th>
    <td class="status-no-burn">
      <div class="restriction-icon-desc">
        <img src="./img/status-no-burn.svg" width="32" height="32" alt="Red circle">
        <p>Burning is not allowed</p>
      </div>
    </td>
  </tr>
  <tr id="Colchester-County">
    <th scope="row">Colchester County</th>
    <td class="status-restricted">
      <div class="restriction-icon-desc">
        <img src="./img/status-restricted.svg" width="32" height="32" alt="Yellow circle">
        <p>Burning is only allowed between 7:00 pm and 8:00 am (burning is not allowed before 7:00 pm)</p>
      </div>
    </td>
  </tr>
  <tr id="Halifax-County">
    <th scope="row">Halifax County</th>
    <td class="status-burn">
      <div class="restriction-icon-desc">
        <img src="./img/status-burn.svg" width="32" height="32" alt="Green circle">
        <p>Burning is allowed between 2:00 pm and 8:00 am</p>
      </div>
    </td>
  </tr>
  <tr id="Hants-County">
    <th scope="row">Hants County</th>
    <td class="status-industrial-only">
      <div class="restriction-icon-desc">
        <p>Only   industrial
          permits are allowed</p>
      </div>
    </td>
  </tr>
</tbody>
</table>`;

describe('parseBurnSafe', () => {
  const counties = parseBurnSafe(PAGE);

  test('reads each county row with its own level', () => {
    expect(counties.get('Colchester')).toEqual({
      county: 'Colchester',
      level: 'restricted',
      label: 'Burn 7 pm – 8 am',
      updated: '24 September 2026 at 2:00 pm',
    });
    expect(counties.get('Halifax')?.level).toBe('burn');
    expect(counties.get('Cape Breton')?.label).toBe('No burning');
  });

  test("falls back to the page's wording for a level it does not know", () => {
    expect(counties.get('Hants')).toMatchObject({
      level: 'industrial-only',
      label: 'Only industrial permits are allowed',
    });
  });

  test('finds nothing on a page without the table', () => {
    expect(parseBurnSafe('<h1>Fire restrictions</h1>').size).toBe(0);
  });
});

describe('parseCountyMap', () => {
  test('maps station IDs to county names', () => {
    expect(
      parseCountyMap('201806=Colchester, 176295=Halifax County,x=Kings,1='),
    ).toEqual(
      new Map([
        [201806, 'Colchester'],
        [176295, 'Halifax'],
      ]),
    );
  });

  test('turns the page row IDs back into names', () => {
    expect(parseCountyMap('1=Cape-Breton-County').get(1)).toBe('Cape Breton');
  });
});
