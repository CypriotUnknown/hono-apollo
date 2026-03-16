# @cypriot_unknown/apollo-hono

Apollo Server integration for [Hono](https://hono.dev).

Features:
- Full HTTP support: queries, mutations, and `@defer` / `@stream` (chunked responses)
- WebSocket subscriptions with dual-protocol support:
  - `graphql-transport-ws` (Apollo Client ≥ 3.5)
  - `graphql-ws` / `subscriptions-transport-ws` (legacy clients)
- TypeScript-first with strict generics — your context type flows end-to-end

---

## Requirements

| Peer dependency  | Version                      |
|------------------|------------------------------|
| `@apollo/server` | `^4.0.0 \|\| ^5.0.0`        |
| `graphql`        | `^16.0.0`                    |
| `graphql-ws`     | `^5.0.0 \|\| ^6.0.0` _(subscriptions only)_ |
| `hono`           | `^4.0.0`                     |

> The WebSocket handler (`wsHandler`) is supported on **Bun, Cloudflare Workers, and Deno** via Hono's `upgradeWebSocket` helper. The HTTP handler (`httpHandler`) works on any Hono-compatible runtime.

---

## Installation

**Bun**
```sh
bun add @cypriot_unknown/apollo-hono @apollo/server graphql hono
# subscriptions only:
bun add graphql-ws @graphql-tools/schema
```

**JSR (Deno)**
```sh
deno add jsr:@cypriot/apollo-hono
```

**JSR (Bun)**
```sh
bunx jsr add @cypriot/apollo-hono
```

---

## HTTP handler — queries & mutations

### Basic

```ts
import { ApolloServer } from '@apollo/server';
import { Hono } from 'hono';
import { httpHandler } from '@cypriot_unknown/apollo-hono';

const server = new ApolloServer({
  typeDefs: `type Query { hello: String }`,
  resolvers: { Query: { hello: () => 'world' } },
});
await server.start();

const app = new Hono();
app.post('/graphql', httpHandler(server));
app.get('/graphql',  httpHandler(server));

export default { fetch: app.fetch };
```

### With custom context

```ts
import { ApolloServer } from '@apollo/server';
import type { BaseContext } from '@apollo/server';
import { Hono } from 'hono';
import { httpHandler } from '@cypriot_unknown/apollo-hono';

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

## WebSocket handler — subscriptions

WebSocket support is available on **Bun, Cloudflare Workers, and Deno** via
Hono's `upgradeWebSocket` helper. Pass the runtime-specific function in
`options.upgradeWebSocket`.

Use `makeExecutableSchema` from `@graphql-tools/schema` to build the schema
explicitly — it must be passed to both `ApolloServer` and `wsHandler`.

```ts
import { ApolloServer } from '@apollo/server';
import { Hono } from 'hono';
import { upgradeWebSocket, websocket } from 'hono/bun'; // swap for your runtime
import { makeExecutableSchema } from '@graphql-tools/schema';
import { httpHandler, wsHandler } from '@cypriot_unknown/apollo-hono';

const typeDefs = `
  type User         { id: ID! name: String! }
  type Query        { users: [User!]! }
  type Mutation     { addUser(id: ID!, name: String!): User! }
  type Subscription { userAdded: User! }
`;

// --- simple pub/sub ---
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
app.get('/graphql', (c, next) =>
  c.req.header('upgrade') === 'websocket' ? ws(c, next) : http(c, next),
);

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

## API Reference

### `httpHandler(server, options?)`

Creates a Hono middleware that handles GraphQL HTTP requests.

| Parameter         | Type                                                       | Required |
|-------------------|------------------------------------------------------------|----------|
| `server`          | `ApolloServer<TContext>`                                   | Yes      |
| `options.context` | `ContextFunction<[HonoContextFunctionArgument], TContext>` | No       |

### `wsHandler(server, options)`

Creates a Hono middleware that upgrades connections to WebSockets for GraphQL
subscriptions. Supported on Bun, Cloudflare Workers, and Deno.

| Parameter                  | Type                                                       | Required |
|----------------------------|------------------------------------------------------------|----------|
| `server`                   | `ApolloServer<TContext>`                                   | Yes      |
| `options.schema`           | `GraphQLSchema`                                            | Yes      |
| `options.upgradeWebSocket` | `UpgradeWebSocket`                                         | Yes      |
| `options.context`          | `ContextFunction<[HonoContextFunctionArgument], TContext>` | No       |

### `HonoContextFunctionArgument`

```ts
interface HonoContextFunctionArgument {
  honoCtx: Context; // Hono's Context object
}
```

---

## License

MIT
