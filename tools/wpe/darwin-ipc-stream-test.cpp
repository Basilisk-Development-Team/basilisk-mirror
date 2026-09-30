// Exercise the actual GLib IPC stream reader, not a second implementation.
#include "config.h"
#include "Platform/IPC/glib/ConnectionGLib.cpp"
#include <wtf/MainThread.h>
#include <cstdio>
#include <fcntl.h>
#include <unistd.h>

#define CHECK(condition) do { if (!(condition)) { fprintf(stderr, "FAIL line %d: %s\n", __LINE__, #condition); return 1; } } while (0)

int main()
{
    WTF::initializeMainThread();
    int pair[2];
    CHECK(!socketpair(AF_UNIX, SOCK_STREAM, 0, pair));
    auto reader = adoptGRef(g_socket_new_from_fd(pair[0], nullptr));
    CHECK(reader);
    g_socket_set_blocking(reader.get(), FALSE);
    Vector<uint8_t> buffer;
    Vector<UnixFileDescriptor> descriptors;
    auto read = [&] (GError** error) {
        return IPC::readBytesFromSocket(reader.get(), buffer, descriptors, nullptr, error);
    };
    IPC::MessageInfo header(3, 1);
    IPC::AttachmentInfo attachment;
    constexpr char body[] = "xyz";
    // Split every header byte across receive calls, including an EAGAIN between
    // writes. Attach a real descriptor to the first byte only.
    int pipeFDs[2];
    CHECK(!pipe(pipeFDs));
    alignas(cmsghdr) char ancillary[CMSG_SPACE(sizeof(int))] { };
    iovec io { &header, 1 };
    msghdr message { };
    message.msg_iov = &io;
    message.msg_iovlen = 1;
    message.msg_control = ancillary;
    message.msg_controllen = sizeof(ancillary);
    auto* control = CMSG_FIRSTHDR(&message);
    control->cmsg_level = SOL_SOCKET;
    control->cmsg_type = SCM_RIGHTS;
    control->cmsg_len = CMSG_LEN(sizeof(int));
    memcpy(CMSG_DATA(control), pipeFDs, sizeof(int));
    CHECK(sendmsg(pair[1], &message, 0) == 1);
    GError* error = nullptr;
    CHECK(read(&error) == 1 && !error);
    CHECK(descriptors.size() == 1);
    CHECK(fcntl(descriptors[0].value(), F_GETFD) & FD_CLOEXEC);
    for (size_t i = 1; i < sizeof(header); ++i) {
        CHECK(read(&error) == -1 && g_error_matches(error, G_IO_ERROR, G_IO_ERROR_WOULD_BLOCK));
        g_clear_error(&error);
        CHECK(buffer.size() == i && descriptors.size() == 1);
        CHECK(write(pair[1], reinterpret_cast<const char*>(&header) + i, 1) == 1);
        CHECK(read(&error) == 1 && !error);
    }
    // Coalesce this message's tail and the next header in one write. The reader
    // must stop at the first boundary without stealing the following bytes.
    Vector<uint8_t> tail;
    tail.append(std::span { reinterpret_cast<const uint8_t*>(&attachment), sizeof(attachment) });
    tail.append(std::span { reinterpret_cast<const uint8_t*>(body), size_t(3) });
    tail.append(std::span { reinterpret_cast<const uint8_t*>(&header), sizeof(header) });
    CHECK(write(pair[1], tail.span().data(), tail.size()) == static_cast<ssize_t>(tail.size()));
    CHECK(read(&error) == sizeof(attachment) + 3 && !error);
    CHECK(buffer.size() == sizeof(header) + sizeof(attachment) + 3);
    CHECK(!memcmp(buffer.span().data() + sizeof(header) + sizeof(attachment), body, 3));
    CHECK(descriptors.size() == 1);
    CHECK(write(pipeFDs[1], "k", 1) == 1);
    char value;
    CHECK(::read(descriptors[0].value(), &value, 1) == 1 && value == 'k');
    buffer.clear(); descriptors.clear();
    CHECK(read(&error) == sizeof(header) && !error && descriptors.isEmpty());
    close(pair[1]);
    CHECK(read(&error) == 0 && !error);
    CHECK(buffer.size() == sizeof(header));
    close(pipeFDs[0]); close(pipeFDs[1]);
    g_socket_close(reader.get(), nullptr);
    // Oversized frames fail before reading an unbounded body.
    CHECK(!socketpair(AF_UNIX, SOCK_STREAM, 0, pair));
    reader = adoptGRef(g_socket_new_from_fd(pair[0], nullptr));
    g_socket_set_blocking(reader.get(), FALSE);
    buffer.clear();
    IPC::MessageInfo invalid(5000, 0);
    CHECK(write(pair[1], &invalid, sizeof(invalid)) == sizeof(invalid));
    CHECK(read(&error) == sizeof(invalid) && !error);
    CHECK(read(&error) == -1 && g_error_matches(error, G_IO_ERROR, G_IO_ERROR_INVALID_DATA));
    g_clear_error(&error);
    close(pair[1]); g_socket_close(reader.get(), nullptr);
    puts("PASS Darwin GLib stream IPC: fragmented header, EAGAIN, descriptors, coalesced messages, EOF, invalid length");
}
