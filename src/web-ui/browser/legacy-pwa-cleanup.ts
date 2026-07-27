const LEGACY_PWA_CLEANUP_KEY = "wand-legacy-pwa-cleanup-v1";
const LEGACY_CACHE_PREFIXES = ["wand-static-", "wand-runtime-"];

function isLegacyWandServiceWorker(worker: ServiceWorker | null): boolean {
  if (!worker) return false;
  try {
    const scriptUrl = new URL(worker.scriptURL, location.href);
    return scriptUrl.origin === location.origin && scriptUrl.pathname === "/sw.js";
  } catch {
    return false;
  }
}

function isLegacyWandRegistration(registration: ServiceWorkerRegistration): boolean {
  return (
    isLegacyWandServiceWorker(registration.installing)
    || isLegacyWandServiceWorker(registration.waiting)
    || isLegacyWandServiceWorker(registration.active)
  );
}

function hasCompletedCleanup(): boolean {
  try {
    return localStorage.getItem(LEGACY_PWA_CLEANUP_KEY) === "done";
  } catch {
    return false;
  }
}

function markCleanupCompleted(): void {
  try {
    localStorage.setItem(LEGACY_PWA_CLEANUP_KEY, "done");
  } catch {
    // Storage may be disabled; repeating this small cleanup on the next load is safe.
  }
}

async function unregisterLegacyServiceWorkers(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return true;

  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const legacyRegistrations = registrations.filter(isLegacyWandRegistration);
    await Promise.all(legacyRegistrations.map((registration) => registration.unregister()));
    return true;
  } catch {
    return false;
  }
}

async function deleteLegacyCaches(): Promise<boolean> {
  if (!("caches" in window)) return true;

  try {
    const cacheNames = await caches.keys();
    const legacyCacheNames = cacheNames.filter((name) =>
      LEGACY_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix))
    );
    await Promise.all(legacyCacheNames.map((name) => caches.delete(name)));
    return true;
  } catch {
    return false;
  }
}

// Transitional cleanup for installations that visited Wand before PWA support
// was removed. Remove this module after the legacy client migration window.
async function cleanupLegacyPwaState(): Promise<void> {
  if (hasCompletedCleanup()) return;

  const controlledByLegacyWorker = (
    "serviceWorker" in navigator
    && isLegacyWandServiceWorker(navigator.serviceWorker.controller)
  );
  const [workersCleaned, cachesCleaned] = await Promise.all([
    unregisterLegacyServiceWorkers(),
    deleteLegacyCaches(),
  ]);

  if (!workersCleaned || !cachesCleaned) return;
  markCleanupCompleted();

  // unregister() stops future control; reload once to release the current page.
  if (controlledByLegacyWorker) location.reload();
}

void cleanupLegacyPwaState();
