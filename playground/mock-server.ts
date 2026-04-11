const port = Number(process.env.PORT) || 4001;

Bun.serve({
  port,
  fetch() {
    return new Response(`mock-server on port ${port}\n`);
  },
});

console.log(`Mock server listening on http://localhost:${port}`);
