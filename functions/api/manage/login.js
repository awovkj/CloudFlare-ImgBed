import { createSession } from '../../utils/auth/sessionManager.js';

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
    //get the request url
    const url = new URL(request.url);
    const response = Response.redirect(url.origin+"/dashboard", 302)

    if (data?.auth?.method === 'basic' || data?.auth?.method === 'none') {
      const { cookie } = await createSession(env, 'admin');
      response.headers.set('Set-Cookie', cookie);
    }

    return response

  }
