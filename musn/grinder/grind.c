// MuseLinu CREATE2 vanity grinder (C, Keccak-f1600).
//
// Finds a bytes32 salt such that the Arachnid deterministic deployment proxy
// (0x4e59b44847b379578588920cA78FbF26c0B4956C) deploys the given init code at
// an address starting with 0x0000000f (7 zeros + f, 8 hex chars = 32 bits).
//
// CREATE2 address = keccak256(0xff ++ factory ++ salt ++ initCodeHash)[12:]
// The check is on lane 1 of the Keccak state: the address's first 4 bytes
// are the top 4 bytes of lane 1 (little-endian), so we need
// (lane1 >> 32) == 0x0f000000.
//
// Build:  gcc -O3 -march=native -pthread -o grind grind.c
// Usage:  ./grind <name> <initCodeHashHex> [threads] [startSalt]
//         ./grind --selftest        (verify Keccak against known vectors)
//         ./grind --verify <saltHex> <initCodeHashHex>  (print the address)
//
// On success it prints the address + salt and writes
// ../grinder/<name>.salt.json. Other threads stop via a shared flag.
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdatomic.h>
#include <pthread.h>
#include <time.h>
#include <unistd.h>

static const uint64_t RC[24] = {
    0x0000000000000001ULL, 0x0000000000008082ULL, 0x800000000000808aULL,
    0x8000000080008000ULL, 0x000000000000808bULL, 0x0000000080000001ULL,
    0x8000000080008081ULL, 0x8000000000008009ULL, 0x000000000000008aULL,
    0x0000000000000088ULL, 0x0000000080008009ULL, 0x000000008000000aULL,
    0x000000008000808bULL, 0x800000000000008bULL, 0x8000000000008089ULL,
    0x8000000000008003ULL, 0x8000000000008002ULL, 0x8000000000000080ULL,
    0x000000000000800aULL, 0x800000008000000aULL, 0x8000000080008081ULL,
    0x8000000000008080ULL, 0x0000000080000001ULL, 0x8000000080008008ULL
};

// Rotation offsets r[x][y] (x = column, y = row).
static const int R[5][5] = {
    { 0, 36,  3, 41, 18},
    { 1, 44, 10, 45,  2},
    {62,  6, 43, 15, 61},
    {28, 55, 25, 21, 56},
    {27, 20, 39,  8, 14}
};

static inline uint64_t rotl64(uint64_t x, int n) {
    return n ? (x << n) | (x >> (64 - n)) : x;
}

static void keccak_f1600(uint64_t st[25]) {
    for (int round = 0; round < 24; round++) {
        uint64_t C[5], D[5], B[25];
        for (int x = 0; x < 5; x++)
            C[x] = st[x] ^ st[x + 5] ^ st[x + 10] ^ st[x + 15] ^ st[x + 20];
        for (int x = 0; x < 5; x++)
            D[x] = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1);
        for (int x = 0; x < 5; x++)
            for (int y = 0; y < 5; y++)
                st[x + 5 * y] ^= D[x];
        for (int x = 0; x < 5; x++)
            for (int y = 0; y < 5; y++)
                B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(st[x + 5 * y], R[x][y]);
        for (int x = 0; x < 5; x++)
            for (int y = 0; y < 5; y++)
                st[x + 5 * y] = B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y]) & B[(x + 2) % 5 + 5 * y]);
        st[0] ^= RC[round];
    }
}

// keccak256 of an arbitrary short message (single block, len < 136).
static void keccak256_msg(const uint8_t *msg, size_t len, uint8_t out[32]) {
    uint64_t st[25] = {0};
    uint8_t block[136] = {0};
    memcpy(block, msg, len);
    block[len] = 0x01;
    block[135] = 0x80;
    for (int i = 0; i < 17; i++)
        memcpy(&st[i], block + i * 8, 8);
    keccak_f1600(st);
    memcpy(out, st, 32);
}

// --- CREATE2 grinding ---

static const uint8_t FACTORY[20] = {
    0x4e, 0x59, 0xb4, 0x48, 0x47, 0xb3, 0x79, 0x57, 0x85, 0x88,
    0x92, 0x0c, 0xa7, 0x8f, 0xbf, 0x26, 0xc0, 0xb4, 0x95, 0x6c
};

static atomic_int g_found = 0;
static atomic_ulong g_total = 0;
static uint8_t g_init_hash[32];
static char g_name[128];

typedef struct {
    int id;
    int nthreads;
    uint64_t start;
} thread_arg_t;

// Returns 1 if the CREATE2 address for this salt starts with 0x0000000f.
// Also fills out_addr (20 bytes) on match.
static int try_salt(uint64_t salt, uint8_t out_addr[20]) {
    // 88 bytes so the lane-10 memcpy (bytes 80..87) stays in bounds; bytes
    // 85..87 are zero and byte 85 gets the 0x01 pad bit OR-ed in below.
    uint8_t input[88] = {0};
    uint64_t st[25] = {0};
    input[0] = 0xff;
    memcpy(input + 1, FACTORY, 20);
    // salt as 32-byte big-endian at bytes 21..52 (first 24 bytes zero).
    memset(input + 21, 0, 24);
    for (int i = 0; i < 8; i++)
        input[45 + i] = (uint8_t)(salt >> (56 - 8 * i));
    memcpy(input + 53, g_init_hash, 32);
    // Absorb: 85 bytes -> lanes 0..10, pad 0x01 at byte 85, 0x80 at byte 135.
    for (int i = 0; i < 11; i++)
        memcpy(&st[i], input + i * 8, 8);
    st[10] |= (uint64_t)0x01 << 40; // byte 85 is the 6th byte of lane 10
    st[16] = 0x8000000000000000ULL;  // byte 135 is the top byte of lane 16
    keccak_f1600(st);
    // Address = hash bytes 12..31; first 4 address bytes = top of lane 1.
    if ((st[1] >> 32) == 0x0f000000ULL) {
        uint8_t hash[32];
        memcpy(hash, st, 32);
        memcpy(out_addr, hash + 12, 20);
        return 1;
    }
    return 0;
}

static void *worker(void *arg) {
    thread_arg_t *a = (thread_arg_t *)arg;
    uint64_t salt = a->start + (uint64_t)a->id;
    uint64_t step = (uint64_t)a->nthreads;
    uint64_t local = 0;
    uint8_t addr[20];
    while (!atomic_load(&g_found)) {
        if (try_salt(salt, addr)) {
            int expected = 0;
            if (atomic_compare_exchange_strong(&g_found, &expected, 1)) {
                char salt_hex[65], addr_hex[41];
                for (int i = 0; i < 32; i++) {
                    // Rebuild the salt bytes for display.
                    uint8_t sb[32] = {0};
                    for (int j = 0; j < 8; j++) sb[24 + j] = (uint8_t)(salt >> (56 - 8 * j));
                    sprintf(salt_hex + 2 * i, "%02x", sb[i]);
                }
                for (int i = 0; i < 20; i++) sprintf(addr_hex + 2 * i, "%02x", addr[i]);
                salt_hex[64] = 0; addr_hex[40] = 0;
                printf("FOUND %s\n  address: 0x%s\n  salt: 0x%s\n  thread: %d\n",
                       g_name, addr_hex, salt_hex, a->id);
                fflush(stdout);
                char path[256];
                snprintf(path, sizeof(path), "../grinder/%s.salt.json", g_name);
                FILE *f = fopen(path, "w");
                if (f) {
                    fprintf(f, "{\n  \"name\": \"%s\",\n  \"address\": \"0x%s\",\n  \"salt\": \"0x%s\",\n  \"factory\": \"0x4e59b44847b379578588920cA78FbF26c0B4956C\",\n  \"target\": \"0x0000000f\"\n}\n",
                            g_name, addr_hex, salt_hex);
                    fclose(f);
                    printf("  wrote %s\n", path);
                }
            }
            break;
        }
        salt += step;
        if (++local >= 1000000) {
            atomic_fetch_add(&g_total, local);
            local = 0;
        }
    }
    atomic_fetch_add(&g_total, local);
    return NULL;
}

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int parse_hex(const char *s, uint8_t *out, size_t nbytes) {
    if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X')) s += 2;
    if (strlen(s) != nbytes * 2) return -1;
    for (size_t i = 0; i < nbytes; i++) {
        int hi = hexval(s[2 * i]), lo = hexval(s[2 * i + 1]);
        if (hi < 0 || lo < 0) return -1;
        out[i] = (uint8_t)((hi << 4) | lo);
    }
    return 0;
}

static void print_hex(const uint8_t *b, size_t n) {
    for (size_t i = 0; i < n; i++) printf("%02x", b[i]);
}

int main(int argc, char **argv) {
    if (argc >= 2 && strcmp(argv[1], "--selftest") == 0) {
        uint8_t out[32];
        // keccak256("") = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
        keccak256_msg((const uint8_t *)"", 0, out);
        printf("keccak256(\"\")    = "); print_hex(out, 32); printf("\n");
        // keccak256("abc") = 4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45
        keccak256_msg((const uint8_t *)"abc", 3, out);
        printf("keccak256(\"abc\") = "); print_hex(out, 32); printf("\n");
        // keccak256("test") = 9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658
        keccak256_msg((const uint8_t *)"test", 4, out);
        printf("keccak256(\"test\")= "); print_hex(out, 32); printf("\n");
        printf("expected:\n  c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470\n  4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45\n  9c22ff5f21f0b81b113e63f7db6da94fedef11b2119b4088b89664fb9a3cb658\n");
        return 0;
    }
    if (argc >= 4 && strcmp(argv[1], "--verify") == 0) {
        uint8_t salt_bytes[32];
        if (parse_hex(argv[2], salt_bytes, 32) != 0 || parse_hex(argv[3], g_init_hash, 32) != 0) {
            fprintf(stderr, "bad hex\n"); return 1;
        }
        // Reconstruct the salt counter from the last 8 bytes (big-endian).
        uint64_t salt = 0;
        for (int i = 0; i < 8; i++) salt = (salt << 8) | salt_bytes[24 + i];
        uint8_t addr[20];
        // try_salt expects the counter; verify the full 32-byte salt matches.
        if (try_salt(salt, addr)) {
            printf("address: 0x"); print_hex(addr, 20); printf(" (MATCHES 0x0000000f)\n");
        } else {
            // Compute the address directly from the given 32-byte salt.
            uint8_t input[88] = {0};
            uint64_t st[25] = {0};
            input[0] = 0xff;
            memcpy(input + 1, FACTORY, 20);
            memcpy(input + 21, salt_bytes, 32);
            memcpy(input + 53, g_init_hash, 32);
            for (int i = 0; i < 11; i++) memcpy(&st[i], input + i * 8, 8);
            st[10] |= (uint64_t)0x01 << 40;
            st[16] = 0x8000000000000000ULL;
            keccak_f1600(st);
            uint8_t hash[32];
            memcpy(hash, st, 32);
            printf("address: 0x"); print_hex(hash + 12, 20); printf(" (no match)\n");
        }
        return 0;
    }
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <name> <initCodeHashHex> [threads] [startSalt]\n", argv[0]);
        fprintf(stderr, "       %s --selftest\n", argv[0]);
        fprintf(stderr, "       %s --verify <saltHex> <initCodeHashHex>\n", argv[0]);
        return 1;
    }
    strncpy(g_name, argv[1], sizeof(g_name) - 1);
    if (parse_hex(argv[2], g_init_hash, 32) != 0) {
        fprintf(stderr, "bad initCodeHash hex\n"); return 1;
    }
    int nthreads = argc >= 4 ? atoi(argv[3]) : 4;
    uint64_t start = argc >= 5 ? strtoull(argv[4], NULL, 0) : 0;
    if (nthreads < 1) nthreads = 1;
    if (nthreads > 64) nthreads = 64;

    printf("Grinding %s (target 0x0000000f) with %d threads from salt %llu\n",
           g_name, nthreads, (unsigned long long)start);
    printf("initCodeHash: %s\n", argv[2]);
    fflush(stdout);

    pthread_t *ths = malloc(sizeof(pthread_t) * nthreads);
    thread_arg_t *args = malloc(sizeof(thread_arg_t) * nthreads);
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    for (int i = 0; i < nthreads; i++) {
        args[i].id = i;
        args[i].nthreads = nthreads;
        args[i].start = start;
        pthread_create(&ths[i], NULL, worker, &args[i]);
    }
    // Progress reporter (main thread).
    while (!atomic_load(&g_found)) {
        sleep(10);
        if (atomic_load(&g_found)) break;
        clock_gettime(CLOCK_MONOTONIC, &t1);
        double elapsed = (t1.tv_sec - t0.tv_sec) + (t1.tv_nsec - t0.tv_nsec) / 1e9;
        unsigned long total = atomic_load(&g_total);
        printf("  ... %lu hashes in %.0fs (%.2f Mhash/s), ETA to avg 2.15B: %.0fs\n",
               total, elapsed, total / elapsed / 1e6,
               (2.15e9 > total) ? (2.15e9 - total) / (total / elapsed) : 0);
        fflush(stdout);
    }
    for (int i = 0; i < nthreads; i++) pthread_join(ths[i], NULL);
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double elapsed = (t1.tv_sec - t0.tv_sec) + (t1.tv_nsec - t0.tv_nsec) / 1e9;
    printf("Done in %.1fs, %lu hashes total (%.2f Mhash/s)\n",
           elapsed, atomic_load(&g_total), atomic_load(&g_total) / elapsed / 1e6);
    return 0;
}
