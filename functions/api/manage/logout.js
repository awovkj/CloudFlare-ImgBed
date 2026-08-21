import { destroySession } from '../../utils/auth/sessionManager.js';

export async function onRequest(context) {
    // Contents of context object
    const {
      request, // same as existing Worker API
      env, // same as existing Worker API
      params, // if filename includes [id] or [[path]]
      waitUntil, // same as ctx.waitUntil in existing Worker API
      next, // used for middleware or to fetch assets
      data, // arbitrary space for passing data between middlewares
    } = context;
    const cookie = await destroySession(env, request, 'admin');
    return new Response('Logged out.', {
      status: 200,
      headers: {
        'Set-Cookie': cookie,
        'Cache-Control': 'no-store',
      },
    });

  }
