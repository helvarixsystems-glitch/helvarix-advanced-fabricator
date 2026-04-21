export default {
  async fetch() {
    return new Response(
      JSON.stringify({
        status: "ok",
        service: "Helvarix Advanced Fabricator API"
      }),
      { headers: { "content-type": "application/json" } }
    );
  }
};
