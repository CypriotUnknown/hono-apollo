# @cypriot/apollo-hono

Apollo Server integration for [Hono](https://hono.dev) (Bun runtime).

Features:

- Full HTTP support: queries, mutations, and `@defer` / `@stream` (chunked responses)
- HTTP multipart subscriptions (`multipart/mixed; subscriptionSpec=1.0`) for Apollo iOS 2.x
- WebSocket subscriptions with dual-protocol support:
  - `graphql-transport-ws` (Apollo Client >= 3.5)
  - `graphql-ws` / `subscriptions-transport-ws` (legacy clients)
- Request/response body transforms — decrypt incoming bodies, encrypt outgoing responses
- TypeScript-first with strict generics — your context type flows end-to-end

---

## Requirements

| Peer dependency  | Version                                              |
|------------------|------------------------------------------------------|
| `@apollo/server` | `^5.0.0`                                             |
| `graphql`        | `^16.0.0`                                            |
| `graphql-ws`     | `^6.0.0` _(subscriptions only)_                      |
| `hono`           | `^4.0.0`                                             |

> The WebSocket handler (`wsHandler`) is supported on **Bun, Cloudflare Workers, and Deno** via Hono's `upgradeWebSocket` helper. The HTTP handler (`httpHandler`) works on any Hono-compatible runtime.

---

## Installation

**JSR** — import as `@cypriot/apollo-hono`
```sh
bunx jsr add @cypriot/apollo-hono
bun add @apollo/server graphql hono
# subscriptions only:
bun add graphql-ws @graphql-tools/schema
```

**JSR (Deno)**
```sh
deno add jsr:@cypriot/apollo-hono
```

**npm** — import as `@cypriotunknown/apollo-hono`
```sh
npm i @cypriotunknown/apollo-hono @apollo/server graphql hono
```

> **Local dev note:** `graphql` is a peer dependency of this package, so you do not need to add it to your `devDependencies` — it is already satisfied by the peer install. Adding it separately can cause multiple `graphql` instances and subtle runtime errors.

---

## Quick start

### Queries & mutations

```ts
import { ApolloServer } from '@apollo/server';
import { Hono } from 'hono';
import { httpHandler } from '@cypriot/apollo-hono';

const server = new ApolloServer({
  typeDefs: `type Query { hello: String }`,
  resolvers: { Query: { hello: () => 'world' } },
});
await server.start();

const app = new Hono();
app.post('/graphql', httpHandler(server));
app.get('/graphql',  httpHandler(server)); // Apollo Studio / landing page

export default { fetch: app.fetch };
```

### With custom context

```ts
import { ApolloServer } from '@apollo/server';
import type { BaseContext } from '@apollo/server';
import { Hono } from 'hono';
import { httpHandler } from '@cypriot/apollo-hono';

interface MyContext extends BaseContext {
  token: string | undefined;
}

const server = new ApolloServer<MyContext>({
  typeDefs: `type Query { me: String }`,
  resolvers: {
    Query: {
      me: (_parent, _args, ctx) => ctx.token ?? 'anonymous',
    },
  },
});
await server.start();

const app = new Hono();
app.use(
  '/graphql',
  httpHandler(server, {
    context: async ({ honoCtx }) => ({
      token: honoCtx.req.header('authorization'),
    }),
  }),
);

export default { fetch: app.fetch };
```

---

## WebSocket subscriptions

WebSocket support is available on **Bun, Cloudflare Workers, and Deno** via Hono's `upgradeWebSocket` helper. Pass the runtime-specific function in `options.upgradeWebSocket`.

Use `makeExecutableSchema` from `@graphql-tools/schema` to build the schema explicitly — it must be passed to both `ApolloServer` and `wsHandler`.

WebSocket upgrade requests arriving on the same route as `httpHandler` are automatically passed through to `wsHandler` (the HTTP handler calls `next()` when it detects an `Upgrade: websocket` header), so you can chain both on a single GET route.

```ts
import { ApolloServer } from '@apollo/server';
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun'; // swap for your runtime
import { makeExecutableSchema } from '@graphql-tools/schema';
import { httpHandler, wsHandler } from '@cypriot/apollo-hono';

const typeDefs = `
  type User         { id: ID! name: String! }
  type Query        { users: [User!]! }
  type Mutation     { addUser(id: ID!, name: String!): User! }
  type Subscription { userAdded: User! }
`;

import { EventEmitter } from 'node:events';
const ee = new EventEmitter();
const users: { id: string; name: string }[] = [];

const resolvers = {
  Query:    { users: () => users },
  Mutation: {
    addUser(_: unknown, args: { id: string; name: string }) {
      const user = { id: args.id, name: args.name };
      users.push(user);
      ee.emit('USER_ADDED', user);
      return user;
    },
  },
  Subscription: {
    userAdded: {
      subscribe: () =>
        (async function* () {
          while (true) {
            yield await new Promise<{ id: string; name: string }>((resolve) =>
              ee.once('USER_ADDED', resolve),
            );
          }
        })(),
      resolve: (payload: { id: string; name: string }) => payload,
    },
  },
};

const schema = makeExecutableSchema({ typeDefs, resolvers });
const server = new ApolloServer({ schema });
await server.start();

const http = httpHandler(server);
const ws   = wsHandler(server, { schema, upgradeWebSocket });

const app = new Hono();
app.post('/graphql', http);
// httpHandler passes WebSocket upgrades to next(); wsHandler picks them up.
app.get('/graphql', http, ws);

// Bun: export `websocket` alongside `fetch`
export default { fetch: app.fetch, websocket };
```

For **Cloudflare Workers** or **Deno**, swap the import:

```ts
import { upgradeWebSocket } from 'hono/cloudflare-workers'; // or 'hono/deno'
```

Run it:

```sh
bun --hot index.ts
```

---

## HTTP multipart subscriptions (Apollo iOS 2.x)

Apollo iOS 2.x uses the `multipart/mixed; subscriptionSpec=1.0` transport rather than WebSockets. Pass `schema` to `httpHandler` to enable this path — the handler will detect subscription operations and stream each event as a multipart chunk.

Each chunk is wrapped per the spec: `{"payload": <execution result>}`.
`onResponseBody` (if set) is applied to every chunk, so encryption is transparent.

```ts
import { makeExecutableSchema } from '@graphql-tools/schema';
import { httpHandler } from '@cypriot/apollo-hono';

const schema = makeExecutableSchema({ typeDefs, resolvers });
const server = new ApolloServer({ schema });
await server.start();

const app = new Hono();
app.post('/graphql', httpHandler(server, { schema }));
app.get('/graphql',  httpHandler(server, { schema }));
```

---

## Encryption / body transforms

`onRequestBody` and `onResponseBody` let you transparently encrypt and decrypt the HTTP transport without touching your resolvers.

```ts
import { httpHandler } from '@cypriot/apollo-hono';

app.post(
  '/graphql',
  httpHandler(server, {
    onRequestBody: async (body, _honoCtx) => {
      // body is the already-parsed JSON value from the client
      return decrypt(body); // return the plaintext GraphQL request object
    },
    onResponseBody: async (body, _honoCtx) => {
      // body is the parsed GraphQL response JSON
      return encrypt(body); // return any JSON-serialisable value
    },
  }),
);
```

- `onRequestBody` is called once per POST request, after JSON parsing, before Apollo executes.
- `onResponseBody` is called for every response chunk — including `@defer` / `@stream` chunks and HTTP multipart subscription events.
- Non-JSON bodies (e.g. Apollo's HTML landing page) are passed through unchanged.

---

## API Reference

### `httpHandler(server, options?)`

Creates a Hono `MiddlewareHandler` that handles GraphQL HTTP requests (queries, mutations, `@defer`, `@stream`, and optionally HTTP multipart subscriptions).

GET requests are supported for Apollo Studio introspection and the landing page.
WebSocket upgrade requests are passed through via `next()` so a chained `wsHandler` can handle them.

| Parameter              | Type                                                                | Required |
|------------------------|---------------------------------------------------------------------|----------|
| `server`               | `ApolloServer<TContext>`                                            | Yes      |
| `options.context`      | `ContextFunction<[HonoContextFunctionArgument], TContext>`          | No       |
| `options.onRequestBody`  | `(body: any, honoCtx: Context) => Promise<any> \| any`            | No       |
| `options.onResponseBody` | `(body: any, honoCtx: Context) => Promise<any> \| any`            | No       |
| `options.schema`       | `GraphQLSchema`                                                     | No       |

`options.schema` is required only when you need HTTP multipart subscription support (Apollo iOS 2.x).

---

### `wsHandler(server, options)`

Creates a Hono `MiddlewareHandler` that upgrades HTTP connections to WebSockets for GraphQL subscriptions. Supports both the modern `graphql-transport-ws` protocol and the legacy `graphql-ws` / `subscriptions-transport-ws` protocol.

| Parameter                    | Type                                                       | Required |
|------------------------------|------------------------------------------------------------|----------|
| `server`                     | `ApolloServer<TContext>`                                   | Yes      |
| `options.schema`             | `GraphQLSchema`                                            | Yes      |
| `options.upgradeWebSocket`   | `UpgradeWebSocket`                                         | Yes      |
| `options.context`            | `ContextFunction<[HonoContextFunctionArgument], TContext>` | No       |

---

### `HonoContextFunctionArgument`

```ts
interface HonoContextFunctionArgument {
  honoCtx: Context; // Hono's Context object
}
```

---

### `HonoMiddlewareOptions<TContext>`

```ts
interface HonoMiddlewareOptions<TContext extends BaseContext> {
  context?:         ContextFunction<[HonoContextFunctionArgument], TContext>;
  onRequestBody?:   (body: any, honoCtx: Context) => Promise<any> | any;
  onResponseBody?:  (body: any, honoCtx: Context) => Promise<any> | any;
  schema?:          GraphQLSchema;
}
```

---

### `HonoWsHandlerOptions<TContext>`

```ts
interface HonoWsHandlerOptions<TContext extends BaseContext> {
  schema:             GraphQLSchema;
  upgradeWebSocket:   UpgradeWebSocket;
  context?:           ContextFunction<[HonoContextFunctionArgument], TContext>;
}
```

---

## License

MIT
