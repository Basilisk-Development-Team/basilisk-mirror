// Exercise the patched IPC::Semaphore, including transport to a fresh process.
#include "config.h"
#include "IPCSemaphore.h"
#include <wtf/MainThread.h>
#include <cstdio>
#include <cstdlib>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

extern char** environ;
constexpr unsigned rounds = 20000;

static int Child(int socket)
{
    alignas(cmsghdr) char control[CMSG_SPACE(sizeof(int) * 2)] { };
    char byte;
    iovec io { &byte, 1 };
    msghdr message { };
    message.msg_iov = &io;
    message.msg_iovlen = 1;
    message.msg_control = control;
    message.msg_controllen = sizeof(control);
    if (recvmsg(socket, &message, 0) != 1)
        return 20;
    auto* header = CMSG_FIRSTHDR(&message);
    if (!header || header->cmsg_level != SOL_SOCKET || header->cmsg_type != SCM_RIGHTS ||
        header->cmsg_len != CMSG_LEN(sizeof(int) * 2))
        return 21;
    auto* descriptors = reinterpret_cast<int*>(CMSG_DATA(header));
    IPC::Semaphore request(UnixFileDescriptor { descriptors[0], UnixFileDescriptor::Adopt });
    IPC::Semaphore reply(UnixFileDescriptor { descriptors[1], UnixFileDescriptor::Adopt });
    if (!request || !reply)
        return 22;
    for (unsigned i = 0; i < rounds; ++i) {
        if (!request.waitFor(IPC::Timeout(2_s)))
            return 23;
        reply.signal();
    }
    close(socket);
    return 0;
}

int main(int argc, char** argv)
{
    WTF::initializeMainThread();
    if (argc == 2)
        return Child(std::atoi(argv[1]));
    IPC::Semaphore request;
    IPC::Semaphore reply;
    if (!request || !reply || request.waitFor(IPC::Timeout::now()))
        return 1;
    for (unsigned i = 0; i < 100000; ++i)
        request.signal();
    for (unsigned i = 0; i < 100000; ++i) {
        if (!request.waitFor(IPC::Timeout::now()))
            return 2;
    }
    if (request.waitFor(IPC::Timeout(1_ms)))
        return 3;
    // A duplicate must remain usable after the original object's destruction.
    auto duplicate = [] {
        IPC::Semaphore original;
        original.signal();
        return IPC::Semaphore(original.duplicateDescriptor());
    }();
    auto moved = WTF::move(duplicate);
    if (duplicate || !moved.waitFor(IPC::Timeout::now()) || moved.waitFor(IPC::Timeout::now()))
        return 4;
    int sockets[2];
    if (socketpair(AF_UNIX, SOCK_DGRAM, 0, sockets))
        return 5;
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    posix_spawn_file_actions_adddup2(&actions, sockets[1], 198);
    posix_spawn_file_actions_addclose(&actions, sockets[0]);
    posix_spawn_file_actions_addclose(&actions, sockets[1]);
    char descriptorArgument[] = "198";
    char* childArguments[] = { argv[0], descriptorArgument, nullptr };
    pid_t pid;
    int result = posix_spawn(&pid, argv[0], &actions, nullptr, childArguments, environ);
    posix_spawn_file_actions_destroy(&actions);
    close(sockets[1]);
    if (result)
        return 6;
    auto first = request.duplicateDescriptor();
    auto second = reply.duplicateDescriptor();
    alignas(cmsghdr) char control[CMSG_SPACE(sizeof(int) * 2)] { };
    char byte = 1;
    iovec io { &byte, 1 };
    msghdr message { };
    message.msg_iov = &io;
    message.msg_iovlen = 1;
    message.msg_control = control;
    message.msg_controllen = sizeof(control);
    auto* header = CMSG_FIRSTHDR(&message);
    header->cmsg_level = SOL_SOCKET;
    header->cmsg_type = SCM_RIGHTS;
    header->cmsg_len = CMSG_LEN(sizeof(int) * 2);
    auto* descriptors = reinterpret_cast<int*>(CMSG_DATA(header));
    descriptors[0] = first.value();
    descriptors[1] = second.value();
    if (sendmsg(sockets[0], &message, 0) != 1)
        return 7;
    for (unsigned i = 0; i < rounds; ++i) {
        request.signal();
        if (!reply.waitFor(IPC::Timeout(2_s)))
            return 8;
    }
    int status;
    if (waitpid(pid, &status, 0) != pid || !WIFEXITED(status) || WEXITSTATUS(status))
        return 9;
    close(sockets[0]);
    puts("PASS actual WPE IPC::Semaphore: 100000 queued tokens, timeout, move/duplicate lifetime, 20000 fresh-process round trips");
}
