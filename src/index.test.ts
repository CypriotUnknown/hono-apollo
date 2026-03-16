import { defineIntegrationTestSuite } from '@apollo/server-integration-testsuite';
import { ApolloServer } from '@apollo/server';
import { Hono } from 'hono';
import { upgradeWebSocket } from 'hono/bun';
import { httpHandler } from './index';

defineIntegrationTestSuite(async (serverOptions, testOptions) => {
    const server = new ApolloServer(serverOptions);
    await server.start();

    const middleware = testOptions?.context
        ? httpHandler(server, {
              context: async () => testOptions.context!(),
          })
        : httpHandler(server);

    const app = new Hono();
    app.all('/', middleware);

    const bunServer = Bun.serve({
        port: 0, // OS picks an available port
        fetch: app.fetch,
    });

    return {
        server,
        url: `http://localhost:${bunServer.port}`,
        extraCleanup: async () => {
            await bunServer.stop();
        },
    };
});
