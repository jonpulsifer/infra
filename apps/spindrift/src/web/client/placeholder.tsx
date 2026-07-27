/**
 * The scaffold's placeholder screen. It exists to prove the client bundle
 * builds and mounts; every real surface (§18) replaces it.
 *
 * It talks to no endpoint on purpose — the browser's only server surface will
 * be the dispatch endpoint generated from the command registry.
 */
export function Placeholder() {
  return (
    <main>
      <h1>Spindrift</h1>
      <p>Connect a repo, press Deploy, get a URL. None of that is built yet.</p>
    </main>
  );
}
