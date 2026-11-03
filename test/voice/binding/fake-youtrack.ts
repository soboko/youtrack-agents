/**
 * A fake YouTrack for the binding and full-entry tests: a `fetch` serving the JSON shapes the real instance answers
 * with (issues with custom fields, comments with authors, `users/me`), plus the shapes checked live under YA-25 B14
 * (`agiles` with projects, an agile's `currentSprint`, and the POST that echoes `{id, idReadable, $type}`), so a read
 * path that strayed onto them would get a plausible answer and only the recorded requests would show it.
 *
 * The query evaluator understands exactly what the adapter emits: `project: X`, `for: me`, `for: {login}`, `State: {...}`,
 * `#Unresolved`, a parenthesised group of `summary: "word"` joined by `and` or `or`, and `sort by: updated desc`.
 * Unknown terms fail the request, so a query the fake cannot judge never passes silently.
 */

export interface FakeComment {
  author: string;
  fullName: string;
  created: number;
  text: string;
}

export interface FakeIssue {
  key: string;
  summary: string;
  description?: string | null;
  state: string;
  assignee: string | null;
  /** The assignee's full name; the login when absent. User entities carry `login` and `fullName`, and no `name`. */
  assigneeName?: string;
  resolved?: number | null;
  updated: number;
  comments?: FakeComment[];
}

export interface FakeAccount {
  login: string;
  fullName: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | null;
  body: unknown;
}

export interface FakeYouTrackOptions {
  baseUrl?: string;
  /** Bearer token -> the account it belongs to. Any other token is answered 401. */
  accounts: ReadonlyMap<string, FakeAccount>;
  issues: FakeIssue[];
  /** Optional routes answered before the built-in ones, e.g. a failure. */
  override?: (request: RecordedRequest) => Response | undefined;
  /** Requests for another host go here (the Alexa APIs in the full-entry test); 404 by default. */
  otherHost?: (url: URL, init: RequestInit | undefined) => Promise<Response>;
}

export interface FakeYouTrack {
  fetch: typeof fetch;
  requests: RecordedRequest[];
  baseUrl: string;
}

export const FAKE_BASE_URL = 'https://household.youtrack.example';

function issueJson(issue: FakeIssue): Record<string, unknown> {
  const idNumber = issue.key.split('-')[1];
  return {
    id: `2-${idNumber}`,
    idReadable: issue.key,
    summary: issue.summary,
    description: issue.description ?? null,
    resolved: issue.resolved ?? null,
    created: issue.updated - 1000,
    updated: issue.updated,
    reporter: {login: 'owner', $type: 'User'},
    customFields: [
      {
        name: 'State',
        value: {name: issue.state, $type: 'StateBundleElement'},
        $type: 'StateIssueCustomField',
      },
      {
        name: 'Assignee',
        value:
          issue.assignee === null
            ? null
            : {login: issue.assignee, fullName: issue.assigneeName ?? issue.assignee, $type: 'User'},
        $type: 'SingleUserIssueCustomField',
      },
      {name: 'Priority', value: {name: 'Normal', $type: 'EnumBundleElement'}, $type: 'SingleEnumIssueCustomField'},
    ],
    $type: 'Issue',
  };
}

/** Splits `a (b or c) d` into top-level terms, keeping a parenthesised group whole. */
function queryTerms(query: string): string[] {
  const terms: string[] = [];
  let rest = query.trim();
  const patterns = [
    /^project: [A-Za-z][A-Za-z0-9_]*/,
    /^for: me/,
    /^for: \{[^}]*\}/,
    /^State: \{[^}]*\}/,
    /^#Unresolved/,
    /^\((?:summary: "[^"]*"(?: (?:and|or) )?)+\)/,
    /^sort by: updated desc/,
  ];
  while (rest !== '') {
    const match = patterns.map((pattern) => pattern.exec(rest)).find((found) => found !== null);
    if (!match) throw new Error(`fake YouTrack cannot evaluate query at: ${rest}`);
    terms.push(match[0]);
    rest = rest.slice(match[0].length).trim();
  }
  return terms;
}

function matches(issue: FakeIssue, term: string, me: FakeAccount): boolean {
  if (term.startsWith('project: ')) return issue.key.startsWith(`${term.slice('project: '.length)}-`);
  if (term === 'for: me') return issue.assignee === me.login;
  if (term.startsWith('for: {')) return issue.assignee === term.slice('for: {'.length, -1);
  if (term.startsWith('State: {')) return issue.state === term.slice('State: {'.length, -1);
  if (term === '#Unresolved') return (issue.resolved ?? null) === null;
  if (term.startsWith('(')) {
    const words = [...term.matchAll(/summary: "([^"]*)"/g)].map((found) => found[1].toLowerCase());
    const summary = issue.summary.toLowerCase().split(/\W+/);
    const hit = (word: string) => summary.includes(word);
    return term.includes(' or ') ? words.some(hit) : words.every(hit);
  }
  return true;
}

export function createFakeYouTrack(options: FakeYouTrackOptions): FakeYouTrack {
  const baseUrl = options.baseUrl ?? FAKE_BASE_URL;
  const origin = new URL(baseUrl).origin;
  const requests: RecordedRequest[] = [];

  const route = (request: RecordedRequest, me: FakeAccount): Response => {
    const {method, path, query} = request;
    const page = <T>(items: T[]): T[] => {
      const skip = Number(query.$skip ?? '0');
      const top = Number(query.$top ?? String(items.length));
      return items.slice(skip, skip + top);
    };
    if (method === 'GET' && path === '/api/users/me') {
      return Response.json({id: '1-5', login: me.login, fullName: me.fullName, email: null, $type: 'Me'});
    }
    if (method === 'GET' && path === '/api/issues') {
      const terms = queryTerms(query.query ?? '');
      const found = options.issues
        .filter((issue) => terms.every((term) => matches(issue, term, me)))
        .sort((left, right) => right.updated - left.updated);
      return Response.json(page(found.map(issueJson)));
    }
    const issuePath = /^\/api\/issues\/([^/]+)(\/comments)?$/.exec(path);
    if (method === 'GET' && issuePath) {
      const issue = options.issues.find((candidate) => candidate.key === decodeURIComponent(issuePath[1]));
      if (!issue) return Response.json({error: 'Not Found', error_description: 'Entity not found'}, {status: 404});
      // The real server projects to `fields`; the adapter ignores extra attributes, so the fake sends them all.
      if (!issuePath[2]) return Response.json(issueJson(issue));
      return Response.json(
        page(
          (issue.comments ?? []).map((comment, index) => ({
            id: `4-${index + 1}`,
            author: {login: comment.author, fullName: comment.fullName, $type: 'User'},
            text: comment.text,
            created: comment.created,
            $type: 'IssueComment',
          })),
        ),
      );
    }
    // YA-25 B14 live shapes: boards with their projects, a board's current sprint, and the placement echo.
    if (method === 'GET' && path === '/api/agiles') {
      return Response.json(
        page([{id: '108-4', name: 'Household', projects: [{shortName: 'H', $type: 'Project'}], $type: 'Agile'}]),
      );
    }
    if (method === 'GET' && path === '/api/agiles/108-4') {
      return Response.json({
        sprintsSettings: {disableSprints: false, $type: 'SprintsSettings'},
        currentSprint: {id: '109-7', name: 'Week 37', archived: false, $type: 'Sprint'},
        $type: 'Agile',
      });
    }
    if (method === 'POST' && path === '/api/agiles/108-4/sprints/109-7/issues') {
      const id = (request.body as {id?: unknown} | undefined)?.id;
      return Response.json({id, idReadable: 'H-1', $type: 'Issue'});
    }
    return Response.json({error: 'Not Found'}, {status: 404});
  };

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) {
      return options.otherHost ? options.otherHost(url, init) : new Response('unrouted host', {status: 404});
    }
    const headers = new Headers(init?.headers);
    const authorization = headers.get('Authorization');
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const overridden = options.override?.(request);
    if (overridden) return overridden;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    const me = options.accounts.get(token);
    if (me === undefined) {
      // A real provider may echo what it was sent; the binding must not pass that on.
      return Response.json(
        {error: 'invalid_token', error_description: `The token ${token} is expired or revoked`},
        {status: 401},
      );
    }
    return route(request, me);
  };

  return {fetch: fakeFetch, requests, baseUrl};
}
