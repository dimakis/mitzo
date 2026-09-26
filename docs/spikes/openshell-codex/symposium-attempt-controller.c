/* Linux process-tree controller for the isolated Symposium runtime.
 * A subreaper owns one claim and writes terminal proof only after ECHILD.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define CONTROL "/sandbox/.symposium-control"
#define HOME_ROOT "/sandbox/.symposium-seats"
#define WORKSPACE "/sandbox/workspaces/mgmt"

static int valid_claim(const char *claim) {
  if (!claim || strlen(claim) != 64) return 0;
  for (int i = 0; i < 64; i++)
    if (!((claim[i] >= '0' && claim[i] <= '9') ||
          (claim[i] >= 'a' && claim[i] <= 'f'))) return 0;
  return 1;
}

static int exact_proof(const char *proof, const char *claim) {
  char expected[80];
  snprintf(expected, sizeof(expected), "\"claim\":\"%s\"", claim);
  return strstr(proof, expected) && strstr(proof, "\"terminal\":true");
}

static int read_proof(const char *path, const char *claim, char *proof, size_t size) {
  int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return 0;
  ssize_t n = read(fd, proof, size - 1);
  close(fd);
  if (n <= 0 || n >= (ssize_t)size - 1) return 0;
  proof[n] = '\0';
  return exact_proof(proof, claim);
}

static void kill_owned_children(void) {
  char path[100];
  snprintf(path, sizeof(path), "/proc/self/task/%ld/children", (long)getpid());
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return;
  char buffer[4096];
  ssize_t n = read(fd, buffer, sizeof(buffer) - 1);
  close(fd);
  if (n <= 0) return;
  buffer[n] = '\0';
  char *cursor = buffer;
  while (*cursor) {
    char *end;
    long pid = strtol(cursor, &end, 10);
    if (end == cursor) break;
    if (pid > 0) kill((pid_t)pid, SIGKILL);
    cursor = end;
  }
}

static int cancel(const char *socket_path, const char *done_path, const char *claim) {
  char proof[256];
  if (read_proof(done_path, claim, proof, sizeof(proof))) {
    fputs(proof, stdout);
    return 0;
  }
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) return 1;
  struct timeval timeout = {.tv_sec = 15};
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  struct sockaddr_un addr = {.sun_family = AF_UNIX};
  size_t socket_length = strlen(socket_path);
  if (socket_length >= sizeof(addr.sun_path)) { close(fd); return 1; }
  memcpy(addr.sun_path, socket_path, socket_length + 1);
  if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
    close(fd);
    if (read_proof(done_path, claim, proof, sizeof(proof))) { fputs(proof, stdout); return 0; }
    fputs("remote cleanup unconfirmed\n", stderr);
    return 1;
  }
  if (write(fd, "stop\n", 5) != 5) { close(fd); return 1; }
  ssize_t n = read(fd, proof, sizeof(proof) - 1);
  close(fd);
  if (n <= 0) return 1;
  proof[n] = '\0';
  if (!exact_proof(proof, claim)) return 1;
  fputs(proof, stdout);
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 3 || !valid_claim(argv[2]) ||
      (strcmp(argv[1], "run") && strcmp(argv[1], "cancel"))) return 2;
  /* A disconnected cancel client must never kill the owning subreaper. */
  signal(SIGPIPE, SIG_IGN);
  char socket_path[128], done_path[128], home[128];
  snprintf(socket_path, sizeof(socket_path), CONTROL "/%s.sock", argv[2]);
  snprintf(done_path, sizeof(done_path), CONTROL "/%s.done", argv[2]);
  snprintf(home, sizeof(home), HOME_ROOT "/%s", argv[2]);
  if (!strcmp(argv[1], "cancel")) return cancel(socket_path, done_path, argv[2]);
  if (argc < 5 || (strcmp(argv[3], "read") && strcmp(argv[3], "write"))) return 2;
  if (mkdir(CONTROL, 0700) && errno != EEXIST) return 1;
  if (mkdir(HOME_ROOT, 0700) && errno != EEXIST) return 1;
  if (mkdir(home, 0700) && errno != EEXIST) return 1;
  if (access(done_path, F_OK) == 0 || prctl(PR_SET_CHILD_SUBREAPER, 1) != 0) return 1;
  int server = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (server < 0) return 1;
  struct sockaddr_un addr = {.sun_family = AF_UNIX};
  size_t socket_length = strlen(socket_path);
  if (socket_length >= sizeof(addr.sun_path)) return 1;
  memcpy(addr.sun_path, socket_path, socket_length + 1);
  if (bind(server, (struct sockaddr *)&addr, sizeof(addr)) || listen(server, 8)) return 1;
  chmod(socket_path, 0600);
  pid_t primary = fork();
  if (primary < 0) return 1;
  if (primary == 0) {
    close(server);
    if (setsid() < 0 || chdir(WORKSPACE) != 0) _exit(126);
    signal(SIGPIPE, SIG_DFL);
    char *child_argv[argc + 2];
    child_argv[0] = "/usr/local/bin/symposium-seat-landlock";
    child_argv[1] = home;
    child_argv[2] = WORKSPACE;
    child_argv[3] = argv[3];
    for (int i = 4; i < argc; i++) child_argv[i] = argv[i];
    child_argv[argc] = NULL;
    execv(child_argv[0], child_argv);
    _exit(127);
  }
  int stopping = 0, primary_reaped = 0, primary_status = 0;
  int clients[32], client_count = 0;
  for (;;) {
    struct pollfd pollfd = {.fd = server, .events = POLLIN};
    if (poll(&pollfd, 1, 25) > 0 && (pollfd.revents & POLLIN)) {
      int client = accept4(server, NULL, NULL, SOCK_CLOEXEC);
      if (client >= 0) {
        struct timeval timeout = {.tv_sec = 1};
        if (setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout))) {
          close(client);
          continue;
        }
        char request[8] = {0};
        ssize_t n = read(client, request, sizeof(request));
        if (n == 5 && !memcmp(request, "stop\n", 5) && client_count < 32) {
          clients[client_count++] = client;
          stopping = 1;
        } else close(client);
      }
    }
    if (stopping && !primary_reaped) kill(-primary, SIGTERM);
    if (stopping) kill_owned_children();
    for (;;) {
      int status;
      pid_t reaped = waitpid(-1, &status, WNOHANG);
      if (reaped > 0) {
        if (reaped == primary) { primary_reaped = 1; primary_status = status; stopping = 1; }
        continue;
      }
      if (reaped < 0 && errno == ECHILD && primary_reaped) {
        char proof[256], temp_path[160];
        int exit_code = WIFEXITED(primary_status) ? WEXITSTATUS(primary_status) : -1;
        int signal = WIFSIGNALED(primary_status) ? WTERMSIG(primary_status) : 0;
        snprintf(proof, sizeof(proof), "{\"claim\":\"%s\",\"terminal\":true,\"exit_code\":%d,\"signal\":%d}\n", argv[2], exit_code, signal);
        snprintf(temp_path, sizeof(temp_path), "%s.%ld", done_path, (long)getpid());
        int fd = open(temp_path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
        if (fd < 0) return 1;
        size_t length = strlen(proof);
        if (write(fd, proof, length) != (ssize_t)length || fsync(fd) || close(fd) || rename(temp_path, done_path)) return 1;
        for (int i = 0; i < client_count; i++) {
          ssize_t sent = write(clients[i], proof, length);
          (void)sent;
          close(clients[i]);
        }
        unlink(socket_path);
        close(server);
        return 0;
      }
      break;
    }
  }
}
