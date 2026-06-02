export interface SSLConfig {
    key: Buffer;
    cert: Buffer;
    /** 实际生效的证书路径，用于 `/cert/server.crt` 下载路由。 */
    certPath: string;
    /** SHA-256 指纹（大写 + 冒号分隔），方便用户在浏览器里核对。 */
    fingerprint: string;
    /** 是否走的是用户自备证书。true = 自带，false = wand 自签。 */
    userProvided: boolean;
}
export interface EnsureCertificatesOptions {
    /** 用户自带证书路径（PEM）。配了且存在就直接用。 */
    userCertPath?: string;
    userKeyPath?: string;
}
/**
 * 主入口：装载 TLS 证书。优先级（高 → 低）：
 *   1. options.userCertPath / userKeyPath（config.tls）
 *   2. 配置目录下已存在的 server.crt + server.key
 *   3. 用 openssl 现场生成自签
 *   4. node crypto 兜底（产出非法证书，主要避免崩溃）
 */
export declare function ensureCertificates(configDir: string, options?: EnsureCertificatesOptions): SSLConfig;
