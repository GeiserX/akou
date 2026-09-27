# DK-K1: which process holds the Accessibility grant

The question from [DESKTOP.md](../ux/DESKTOP.md) DK-K1 and [DICTATION.md](../ux/DICTATION.md) DC-N3. Dictation's key tap and its paste run in `akou-capture dictate`, which the app's Bun main process starts, which the bundle's launcher starts. Which process does macOS check for Accessibility, and which entry does the user switch on?

Result: pass

## Answer

- macOS checks the grant of the **responsible process**, which is the app bundle that LaunchServices launched. Every process that bundle starts, at any depth, reads the bundle's grant from `AXIsProcessTrusted`.
- In akou that bundle is `akou.app` (`io.github.geiserx.akou`). Its `Contents/MacOS/launcher` is the responsible process of the Bun main process, and so of every helper Bun starts. On the first launch the stable wrapper unpacks the app in place and launches it again; the relaunched launcher is the responsible one, with the same path and bundle id.
- So the user switches on **akou** under System Settings > Privacy & Security > Accessibility, and the helper asks `AXIsProcessTrusted` in its own process, because it creates the tap and posts the events. There is no separate entry for the helper.
- A grant on the helper's own path does nothing. With only that row, every process read `false`.
- Disclaiming responsibility does not give a binary inside the bundle its own grant. The child started with `responsibility_spawnattrs_setdisclaim` became its own responsible process, yet read the bundle's answer in every case: `true` with the bundle row, `false` with only its path row.
- **Trap for CI.** A process started from a CI step on a GitHub macOS runner reads `true`, because its responsible process is the runner's agent (`/opt/hca/hosted-compute-agent`), which the runner image grants Accessibility. That is why the helper's real tap can run in CI. A CI check that expects "not granted" has to launch through `open`, so that a bundle is responsible.

## The check

- Date: 2026-09-27. akou at `3b3b3c4` (main).
- A GitHub `macos-latest` runner: image `macos-26-arm64` 20260907.0351, macOS 26.6.2, System Integrity Protection disabled, passwordless `sudo`, so the system TCC database can be written.
- Run: <https://github.com/GeiserX/akou/actions/runs/36289685902> (jobs `model` and `app`).

### The rule, on a model bundle

`K1Spike.app` (`org.akou.k1spike`), signed ad hoc, holds one small C program twice in `Contents/MacOS`: as `launcher` (the bundle's executable) and as `probe`. Each copy writes its pid, `AXIsProcessTrusted()` and its responsible process (`responsibility_get_pid_responsible_for_pid`), then starts the next with `posix_spawn`. `open -W -n K1Spike.app` ran two chains per case: launcher, child, grandchild; and launcher, then a child started with responsibility disclaimed. Between cases the job wrote or deleted a `kTCCServiceAccessibility` row in `/Library/Application Support/com.apple.TCC/TCC.db` (`auth_value` 2, no `csreq`) and restarted `tccd`.

| TCC row | launcher | child | grandchild | disclaimed child |
|---|---|---|---|---|
| none | false | false | false | false |
| the bundle id | true | true | true | true |
| only the path of `probe` | false | false | false | false |
| removed again | false | false | false | false |

The responsible process was the launcher for the launcher, the child and the grandchild, and the disclaimed child itself for the disclaimed child. A `probe` started straight from the CI shell read `true`, responsible `/opt/hca/hosted-compute-agent`.

### The chain, on the real app

The same run built the app with [`bun scripts/build-app.ts`](../../scripts/build-app.ts), opened the wrapper with `open`, waited 45 s and asked `launchctl procinfo` for each process's responsible pid:

| pid | parent | process | responsible |
|---|---|---|---|
| 16231 | 1 | the wrapper's `launcher` (its path no longer resolves, because the app was unpacked over it) | itself |
| 16254 | 1 | `akou.app/Contents/MacOS/launcher` | itself |
| 16255 | 16254 | `akou.app/Contents/MacOS/bun …/Resources/main.js` | 16254 |

No second bundle was left under `~/Library/Application Support`, so the wrapper unpacks in place.

### Still open

- The same on a real Mac, with the grant switched in System Settings. The rows written here carry no code requirement. A grant System Settings writes does, and an ad hoc signature changes with every build, so a new build can lose the grant; `grant.lost` ([DC-N1](../ux/DICTATION.md#9-the-platform-layer)) is how the helper reports that.
- The real app with a row for `io.github.geiserx.akou`. The app starts no helper at launch, so this run measured the chain but not the grant through it. The model covers the rule.

### The probe

```c
// cc -O2 -o probe probe.c -framework ApplicationServices
// probe OUT ROLE [ROLE...]: appends one JSON line to OUT, then starts itself for the next ROLE
// (with responsibility disclaimed when that role's name contains "disclaim").
#include <ApplicationServices/ApplicationServices.h>
#include <dlfcn.h>
#include <libproc.h>
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
typedef pid_t (*resp_fn)(pid_t);
typedef int (*disclaim_fn)(posix_spawnattr_t *, int);
int main(int argc, char **argv) {
  if (argc < 3) return 64;
  char self[PROC_PIDPATHINFO_MAXSIZE] = {0}, rpath[PROC_PIDPATHINFO_MAXSIZE] = {0};
  proc_pidpath(getpid(), self, sizeof self);
  resp_fn resp = (resp_fn)dlsym(RTLD_DEFAULT, "responsibility_get_pid_responsible_for_pid");
  pid_t r = resp ? resp(getpid()) : -1;
  if (r > 0) proc_pidpath(r, rpath, sizeof rpath);
  FILE *f = fopen(argv[1], "a");
  fprintf(f, "{\"role\":\"%s\",\"pid\":%d,\"ppid\":%d,\"path\":\"%s\",\"trusted\":%s,"
          "\"responsible_pid\":%d,\"responsible\":\"%s\"}\n",
          argv[2], getpid(), getppid(), self, AXIsProcessTrusted() ? "true" : "false", r, rpath);
  fclose(f);
  if (argc > 3) {
    posix_spawnattr_t attr;
    posix_spawnattr_init(&attr);
    if (strstr(argv[3], "disclaim")) {
      disclaim_fn d = (disclaim_fn)dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
      if (d) d(&attr, 1);
    }
    char next[PROC_PIDPATHINFO_MAXSIZE];
    snprintf(next, sizeof next, "%s", self);
    snprintf(strrchr(next, '/') + 1, 8, "probe");
    char *args[16] = {next, argv[1]};
    for (int i = 3; i < argc && i < 15; i++) args[i - 1] = argv[i];
    args[argc - 1] = NULL;
    pid_t c;
    if (posix_spawn(&c, next, NULL, &attr, args, environ) == 0) waitpid(c, NULL, 0);
  }
  return 0;
}
```

A grant, and the cases:

```sh
DB="/Library/Application Support/com.apple.TCC/TCC.db"
grant() { # CLIENT CLIENT_TYPE (0 bundle id, 1 path)
  sudo sqlite3 "$DB" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value,
    auth_reason, auth_version, csreq, policy_id, indirect_object_identifier_type,
    indirect_object_identifier, indirect_object_code_identity, flags, last_modified)
    VALUES ('kTCCServiceAccessibility', '$1', $2, 2, 4, 1, NULL, NULL, 0, 'UNUSED', NULL, 0, $(date +%s))"
}
reload() { sudo killall tccd; killall tccd; sleep 2; }
run() { # OUT
  open -W -n K1Spike.app --args "$1" launcher child grandchild
  open -W -n K1Spike.app --args "$1" launcher-d child-disclaim
}
```
