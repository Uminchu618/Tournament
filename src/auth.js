import {createRemoteJWKSet, jwtVerify} from 'jose';
import {HttpError} from './errors.js';

const keys = new Map();
export async function authenticate(request, env, resolveKeys) {
  let email, subject;
  const hostname = new URL(request.url).hostname;
  if (env.ENVIRONMENT === 'local' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    email = 'dev@localhost';
  } else {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new HttpError(503, '運営者認証の設定が完了していません');
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token) throw new HttpError(401, 'ログインが必要です');
    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    if (!keys.has(issuer)) keys.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));
    let payload;
    try {({payload} = await jwtVerify(token, resolveKeys??keys.get(issuer), {issuer, audience: env.ACCESS_AUD, algorithms: ['RS256']}));}
    catch {throw new HttpError(401, 'ログインの有効期限または認証情報を確認してください');}
    if (typeof payload.email === 'string' && payload.email.trim() && typeof payload.sub === 'string' && payload.sub) {
      email = payload.email.toLowerCase(); subject = payload.sub;
    } else if (env.ENVIRONMENT === 'staging' && env.E2E_SERVICE_CLIENT_ID && payload.common_name === env.E2E_SERVICE_CLIENT_ID) {
      subject = `service:${payload.common_name}`;
    } else throw new HttpError(403, 'この認証方法では操作できません');
  }
  const operator = email
    ? await env.DB.prepare('SELECT * FROM operators WHERE email = ? AND active = 1').bind(email).first()
    : await env.DB.prepare('SELECT * FROM operators WHERE access_subject = ? AND active = 1').bind(subject).first();
  if (!operator || (subject && operator.access_subject && operator.access_subject !== subject)) {
    throw new HttpError(403, '運営者として登録されていません');
  }
  if (subject && !operator.access_subject) {
    await env.DB.prepare('UPDATE operators SET access_subject = ?, updated_at = ? WHERE id = ? AND access_subject IS NULL AND active = 1')
      .bind(subject, new Date().toISOString(), operator.id).run();
    const current = await env.DB.prepare('SELECT access_subject, active FROM operators WHERE id = ?').bind(operator.id).first();
    if (!current?.active || current.access_subject !== subject) throw new HttpError(403, '運営者の登録状態を確認してください');
  }
  return {id: operator.id, email: operator.email, role: operator.role};
}
