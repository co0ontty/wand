type Snapshot = { id: string; [key: string]: unknown };

/** HTTP reads share ordering and protect fields written by pushes or actions while awaiting IO. */
export function createSessionReads() {
  const active = new Map<string, Map<string, Set<string>>>();
  return {
    begin(key: string) {
      const changes = new Map<string, Set<string>>();
      active.set(key, changes);
      return {
        isCurrent: () => active.get(key) === changes,
        changed: (id: string) => changes.has(id),
        merge<T extends Snapshot>(remote: T, current?: Snapshot): T {
          const result = { ...remote };
          if (current) {
            for (const field of changes.get(remote.id) ?? []) {
              if (field in current) (result as Snapshot)[field] = current[field];
              else delete result[field];
            }
          }
          return result;
        },
        finish() {
          if (active.get(key) === changes) active.delete(key);
        },
      };
    },
    record(snapshot: Snapshot): void {
      for (const changes of active.values()) {
        let fields = changes.get(snapshot.id);
        if (!fields) changes.set(snapshot.id, fields = new Set());
        for (const field of Object.keys(snapshot)) {
          if (field !== "id") fields.add(field);
        }
        // Body and cursors are one atomic window. A push without an explicit
        // cursor must not let an older HTTP cursor reinterpret the new body.
        if ("messages" in snapshot) {
          for (const field of ["messages", "messageOffset", "messageTotal", "leadingBlockOffset", "leadingBlockTotal"]) fields.add(field);
        }
        if ("permissionBlocked" in snapshot || "pendingEscalation" in snapshot) {
          fields.add("permissionBlocked"); fields.add("pendingEscalation");
        }
      }
    },
    reset(): void { active.clear(); },
  };
}
