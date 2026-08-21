export async function onRequest() {
    return new Response('true', {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
}
