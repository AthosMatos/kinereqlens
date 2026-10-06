/**
 * Suite 4 — GraphQL: Query / Variables / Operation name sections → edit a variable → Send → echo → revert.
 */
import { GRAPHQL_QUERY } from './server';
import { expect, test, tid } from './fixtures';

interface GqlEcho {
  query: string;
  variables: Record<string, unknown>;
  operationName: string;
  extensions: unknown;
  bodyText: string;
}

test.describe('GraphQL', () => {
  test('sections, variable edit, send and revert', async ({ rl }) => {
    await rl.openApp();
    await rl.clickApp('graphql');
    await rl.select('/graphql');
    const body = rl.section('body');
    await expect(body.locator('.rl-ed-bodybar__flavor')).toHaveText('GraphQL');

    // Sections in GraphQL order with their titles.
    const titles = await body.locator('.rl-gql > .rl-jed-list--cards > .rl-card .rl-jed-title').allTextContents();
    expect(titles).toEqual(['Query', 'Variables', 'Operation name']);
    const query = body.locator(tid('rl-gql-query'));
    await expect(query).toHaveValue(GRAPHQL_QUERY);
    await expect(body.locator('.rl-gql-op')).toHaveText('query GetUser');
    await expect(rl.jsonValue('variables.id')).toHaveValue('42');
    await expect(rl.jsonValue('variables.first')).toHaveValue('10');
    await expect(rl.jsonValue('operationName')).toHaveValue('GetUser');
    // Missing standard sections can be added.
    await expect(body.locator(`${tid('rl-gql-add-section')}[data-key="extensions"]`)).toBeVisible();

    // Edit variables (string + number) and send.
    await rl.jsonValue('variables.id').fill('7');
    await rl.jsonValue('variables.first').fill('25');
    await expect(rl.jsonNode('variables')).toHaveAttribute('data-modified', 'true');
    await expect(rl.jsonNode('query')).toHaveAttribute('data-modified', 'false');
    expect(await rl.send()).toBe('done');
    let echo = await rl.echo<GqlEcho>();
    expect(echo).toMatchObject({ query: GRAPHQL_QUERY, variables: { id: '7', first: 25 }, operationName: 'GetUser' });
    expect(echo.bodyText).toBe(JSON.stringify({ query: GRAPHQL_QUERY, variables: { id: '7', first: 25 }, operationName: 'GetUser' }));

    // Edit the query document and the operation name; the operation pill follows.
    const newQuery = GRAPHQL_QUERY.replace('query GetUser', 'query FetchUser');
    await query.fill(newQuery);
    await expect(body.locator('.rl-gql-op')).toHaveText('query FetchUser');
    await rl.jsonValue('operationName').fill('FetchUser');
    await body.locator(`${tid('rl-gql-add-section')}[data-key="extensions"]`).click();
    await expect(rl.jsonNode('extensions')).toHaveAttribute('data-type', 'object');
    expect(await rl.send()).toBe('done');
    echo = await rl.echo<GqlEcho>();
    expect(echo).toMatchObject({ query: newQuery, operationName: 'FetchUser', variables: { id: '7', first: 25 }, extensions: {} });

    // Revert the Variables card only, then everything.
    await rl.jsonNode('variables').locator(tid('rl-json-revert')).click();
    await expect(rl.jsonValue('variables.id')).toHaveValue('42');
    await expect(rl.jsonNode('query')).toHaveAttribute('data-modified', 'true');
    await rl.ui.locator(tid('rl-revert-all')).click();
    await expect(query).toHaveValue(GRAPHQL_QUERY);
    await expect(rl.jsonNode('extensions')).toHaveCount(0);
    expect(await rl.send()).toBe('done');
    echo = await rl.echo<GqlEcho>();
    expect(echo).toMatchObject({ query: GRAPHQL_QUERY, variables: { id: '42', first: 10 }, operationName: 'GetUser' });
  });
});
