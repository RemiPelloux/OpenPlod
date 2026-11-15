//! Isolated owner sign-in. No password scraping, browser-profile access or cookie persistence.
use std::{sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri::webview::NewWindowResponse;

const GOOGLE_ACCOUNT_DOMAINS: &str = include_str!("google-account-domains.txt");

const PROVIDER_WINDOW: &str = "plaud-sign-in-provider";

fn provider_url_allowed(url: &tauri::Url) -> bool {
    // Some identity providers first open a blank window and then navigate it.
    url.as_str() == "about:blank" || (url.scheme() == "https"
        && url.username().is_empty() && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && url.host_str().is_some_and(|host| {
            GOOGLE_ACCOUNT_DOMAINS.lines().any(|allowed| allowed == host)
                || matches!(host, "accounts.youtube.com" | "accounts.blogger.com" | "appleid.apple.com" | "account.apple.com" | "web.plaud.ai")
        }))
}

fn is_plaud_session_cookie(name: &str, domain: Option<&str>, path: Option<&str>, value: &str) -> bool {
    name == "pld_ut" && !value.is_empty()
        && matches!(domain, Some("plaud.ai" | ".plaud.ai" | "web.plaud.ai" | ".web.plaud.ai"))
        && matches!(path, None | Some("/"))
}

fn blocked_destination(url: &tauri::Url) -> String {
    // Never expose OAuth paths, query parameters, fragments or user information.
    let destination = match url.host_str() {
        Some(host) => format!("{}://{}:{}", url.scheme(), host, url.port_or_known_default().unwrap_or(0)),
        None => format!("{} (opaque)", url.scheme()),
    };
    format!("Sign-in navigation blocked: {destination}. No token is displayed. Report this destination to correct the filter.")
}

#[derive(Default)]
pub struct LoginState(Mutex<Option<Arc<AtomicBool>>>);

fn trusted(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "Cannot verify the application window.")?;
    if !trusted_origin(window.label(), &url) {
        return Err("Sign-in is only available from the local OpenPlod window.".into());
    }
    Ok(())
}

fn trusted_origin(label: &str, url: &tauri::Url) -> bool {
    label == "main" && matches!(url.scheme(), "tauri" | "http" | "https")
        && matches!(url.host_str(), Some("localhost" | "tauri.localhost" | "127.0.0.1"))
}

#[tauri::command]
pub async fn plaud_sign_in(app: tauri::AppHandle, window: WebviewWindow) -> Result<String, String> {
    trusted(&window)?;
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let state = app.state::<LoginState>();
        let mut current = state.0.lock().map_err(|_| "Sign-in state unavailable.")?;
        if current.is_some() { return Err("A Plaud sign-in is already running.".into()); }
        *current = Some(cancelled.clone());
    }
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let url: tauri::Url = "https://web.plaud.ai/".parse().unwrap();
        let popup_app = worker_app.clone();
        let popup_error = Arc::new(Mutex::new(None::<String>));
        let handler_error = popup_error.clone();
        let popup_cancelled = cancelled.clone();
        let login = WebviewWindowBuilder::new(&worker_app, "plaud-sign-in", WebviewUrl::External(url.clone()))
            .title("Plaud — OpenPlod").inner_size(960.0, 720.0).incognito(true)
            .on_navigation(|url| url.scheme() == "https")
            .on_new_window(move |url, features| {
                if popup_cancelled.load(Ordering::SeqCst) { return NewWindowResponse::Deny; }
                if !provider_url_allowed(&url) {
                    if let Ok(mut error) = handler_error.lock() {
                        *error = Some(blocked_destination(&url));
                    }
                    return NewWindowResponse::Deny;
                }
                if let Some(existing) = popup_app.get_webview_window(PROVIDER_WINDOW) {
                    let _ = existing.set_focus();
                    return NewWindowResponse::Deny;
                }
                let navigation_error = handler_error.clone();
                // window_features shares the opener configuration and session; an
                // unrelated webview or external browser loses the OAuth popup reply.
                let provider = WebviewWindowBuilder::new(&popup_app, PROVIDER_WINDOW, WebviewUrl::External("about:blank".parse().unwrap()));
                // WebView2 requires the popup controller to share the opener profile.
                #[cfg(target_os = "windows")]
                let provider = provider.incognito(true);
                match provider
                    .window_features(features).title("Plaud — Sign in").inner_size(600.0, 760.0)
                    .on_navigation(move |url| {
                        let allowed = provider_url_allowed(url);
                        if !allowed {
                            if let Ok(mut error) = navigation_error.lock() {
                                *error = Some(blocked_destination(url));
                            }
                        }
                        allowed
                    })
                    .build() {
                        Ok(window) => NewWindowResponse::Create { window },
                        Err(_) => {
                            if let Ok(mut error) = handler_error.lock() {
                                *error = Some("Could not open the provider sign-in window. Please retry.".into());
                            }
                            NewWindowResponse::Deny
                        }
                    }
            })
            .build().map_err(|_| "Could not open Plaud sign-in. Please retry.".to_string())?;
        let result = (|| {
            let deadline = Instant::now() + Duration::from_secs(300);
            while Instant::now() < deadline {
                if let Some(error) = popup_error.lock().map_err(|_| "Sign-in state unavailable.")?.take() {
                    return Err(error);
                }
                if cancelled.load(Ordering::SeqCst) || worker_app.get_webview_window("plaud-sign-in").is_none() {
                    return Err("Plaud sign-in cancelled.".into());
                }
                // This must run outside the UI thread (WebView2/WKWebView cookie API).
                // Wry 0.57 cookies_for_url compares domains literally and misses
                // parent-domain cookies such as .plaud.ai. Filter the private store explicitly.
                let cookies = login.cookies()
                    .map_err(|_| "Could not read the Plaud session. Close the window and retry.".to_string())?;
                if let Some(cookie) = cookies.iter().find(|cookie| is_plaud_session_cookie(cookie.name(), cookie.domain(), cookie.path(), cookie.value())) {
                    if cancelled.load(Ordering::SeqCst) { return Err("Plaud sign-in cancelled.".into()); }
                    return Ok(cookie.value().to_owned());
                }
                std::thread::sleep(Duration::from_millis(750));
            }
            Err("Plaud sign-in timed out. Please retry.".into())
        })();
        // The incognito store is discarded with the window, including on error/cancel.
        if let Some(popup) = worker_app.get_webview_window(PROVIDER_WINDOW) { let _ = popup.close(); }
        let _ = login.close();
        result
    }).await.map_err(|_| "Plaud sign-in stopped unexpectedly. Please retry.".to_string());
    if let Ok(mut current) = app.state::<LoginState>().0.lock() { *current = None; }
    result?
}

#[tauri::command]
pub async fn plaud_cancel_sign_in(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    trusted(&window)?;
    if let Some(cancelled) = app.state::<LoginState>().0.lock().map_err(|_| "Sign-in state unavailable.")?.as_ref() {
        cancelled.store(true, Ordering::SeqCst);
    }
    // The worker closes its own window after observing cancellation, avoiding a
    // close-versus-cookie-read race. No authentication material is written here.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_popups_accept_only_the_expected_secure_origins() {
        for value in ["about:blank", "https://accounts.google.com/o/oauth2/auth", "https://accounts.google.fr/", "https://appleid.apple.com/auth/authorize", "https://web.plaud.ai/login"] {
            assert!(provider_url_allowed(&value.parse().unwrap()));
        }
        for value in ["http://accounts.google.com", "https://accounts.google.com.attacker.example", "https://accounts.google.fr.attacker.example", "http://accounts.google.fr", "https://accounts.google.fr:8443", "https://accounts.google.com@attacker.example", "https://user@accounts.google.com", "https://accounts.google.com:8443", "file:///tmp/page.html", "javascript:alert(1)", "tauri://localhost"] {
            assert!(!provider_url_allowed(&value.parse().unwrap()));
        }
    }

    #[test]
    fn regional_google_and_shared_signin_redirects_are_supported_together() {
        let hosts: Vec<_> = GOOGLE_ACCOUNT_DOMAINS.lines().filter(|h| !h.starts_with('#')).collect();
        assert_eq!(hosts.len(), 187);
        for host in hosts.iter().copied().chain(["accounts.youtube.com", "accounts.blogger.com"]) {
            for path in ["/v3/signin/identifier", "/v3/signin/challenge/totp", "/accounts/SetSID", "/signin/oauth/consent", "/gsi/transform"] {
                assert!(provider_url_allowed(&format!("https://{host}{path}?synthetic=1").parse().unwrap()), "{host}{path}");
            }
            for url in [format!("http://{host}/"), format!("https://{host}.attacker.example/"), format!("https://{host}@attacker.example/"), format!("https://user@{host}/"), format!("https://{host}:8443/")] {
                assert!(!provider_url_allowed(&url.parse().unwrap()), "{url}");
            }
        }
        for url in ["https://accounts.google.evil", "https://accounts.google.invalid", "https://evil.accounts.google.fr", "https://127.0.0.1", "https://localhost", "https://accounts.youtube.com.attacker.example"] {
            assert!(!provider_url_allowed(&url.parse().unwrap()));
        }
    }

    #[test]
    fn plaud_cookie_return_accepts_parent_domain_but_never_google_or_lookalikes() {
        for domain in ["plaud.ai", ".plaud.ai", "web.plaud.ai", ".web.plaud.ai"] {
            assert!(is_plaud_session_cookie("pld_ut", Some(domain), Some("/"), "synthetic"));
        }
        for domain in ["accounts.google.com", ".google.fr", "plaud.ai.attacker.example", "evil.plaud.ai"] {
            assert!(!is_plaud_session_cookie("pld_ut", Some(domain), Some("/"), "synthetic"));
        }
        assert!(!is_plaud_session_cookie("pld_ut", None, Some("/"), "synthetic"));
        assert!(!is_plaud_session_cookie("pld_ut", Some("plaud.ai"), Some("/other"), "synthetic"));
        assert!(!is_plaud_session_cookie("pld_ut", Some("plaud.ai"), Some("/"), ""));
        assert!(!is_plaud_session_cookie("SID", Some("plaud.ai"), Some("/"), "synthetic"));
    }

    #[test]
    fn blocked_destination_does_not_disclose_credentials() {
        let url = "https://user:password@example.test/private-code?token=secret#credential".parse().unwrap();
        let message = blocked_destination(&url);
        assert!(message.contains("https://example.test:443"));
        for secret in ["user", "password", "private-code", "token=", "secret", "credential"] {
            assert!(!message.contains(secret));
        }
    }

    #[test]
    fn login_commands_reject_remote_pages_and_the_login_window() {
        for value in ["https://web.plaud.ai", "https://localhost.attacker.example", "file:///tmp/index.html"] {
            assert!(!trusted_origin("main", &value.parse().unwrap()));
        }
        assert!(!trusted_origin("plaud-sign-in", &"https://web.plaud.ai".parse().unwrap()));
        assert!(!trusted_origin("plaud-sign-in", &"tauri://localhost".parse().unwrap()));
        for value in ["tauri://localhost", "http://tauri.localhost", "http://localhost:5173"] {
            assert!(trusted_origin("main", &value.parse().unwrap()));
        }
    }
}
