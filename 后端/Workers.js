addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url)

  // 仅处理 /proxy/* 路径
  const pathSegments = url.pathname.split('/')
  if (pathSegments[1] !== 'proxy') {
    return new Response('非法访问，路径格式应为 /proxy/<encoded-url>', { status: 501 })
  }

  // 解码目标URL
  const encodedUrl = pathSegments.slice(2).join('/')
  let targetUrl
  try {
    if (encodedUrl) {
      targetUrl = decodeURIComponent(encodedUrl)
      if (!/^https?:\/\//i.test(targetUrl)) {
        targetUrl = `https://${targetUrl}`
      }
      new URL(targetUrl) // 验证URL合法性
    } else {
      // 默认访问 Google
      targetUrl = 'https://www.google.com'
    }
  } catch (e) {
    return new Response('Invalid URL', { status: 400 })
  }

  const target = new URL(targetUrl)

  // 复制原请求 Headers，并设置 Host 头
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('Host', target.host)

  const modifiedRequest = new Request(target.toString(), {
    method: request.method,
    headers: requestHeaders,
    body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : null,
    redirect: 'manual' // 手动处理重定向
  })

  try {
    const response = await fetch(modifiedRequest)
    let modifiedResponse = new Response(response.body, response)

    // 重写 Set-Cookie，移除 Domain 属性
    if (response.headers.has('Set-Cookie')) {
      const cookies = response.headers.getAll('Set-Cookie').map(cookie => rewriteSetCookie(cookie))
      modifiedResponse.headers.delete('Set-Cookie')
      for (const cookie of cookies) {
        modifiedResponse.headers.append('Set-Cookie', cookie)
      }
    }

    // 重写 Location 头为绝对代理URL
    if (response.headers.has('Location')) {
      const location = response.headers.get('Location')
      const rewrittenLocation = rewriteLocation(location, target, url.origin)
      modifiedResponse.headers.set('Location', rewrittenLocation)
    }

    // 移除安全相关头部
    modifiedResponse.headers.delete('Content-Security-Policy')
    modifiedResponse.headers.delete('X-Frame-Options')
    modifiedResponse.headers.delete('X-Content-Type-Options')

    const contentType = response.headers.get('Content-Type') || ''
    if (contentType.includes('text/html')) {
      let html = await modifiedResponse.text()

      // 使用HTMLRewriter处理HTML结构
      let intermediateResponse = new Response(html, { headers: { 'Content-Type': 'text/html' } })
      intermediateResponse = await applyHTMLRewriter(intermediateResponse, target)
      html = await intermediateResponse.text()

      // 对内联JS跳转进行正则替换
      html = rewriteInlineJS(html, target, url.origin)

      // 注入伪造环境的脚本
      html = injectFakeEnvScript(html, target, url.origin)

      return new Response(html, {
        status: modifiedResponse.status,
        headers: modifiedResponse.headers
      })
    }

    return modifiedResponse
  } catch (error) {
    return new Response('Error fetching the target site.', { status: 500 })
  }
}

function rewriteSetCookie(cookieStr) {
  // 移除 Domain，使Cookie成为Host-only Cookie
  return cookieStr.replace(/;?\s*Domain=[^;]+/i, '')
}

function rewriteLocation(location, target, proxyOrigin) {
  try {
    const absoluteUrl = new URL(location, target)
    const encodedUrl = encodeURIComponent(absoluteUrl.toString())
    return `${proxyOrigin}/proxy/${encodedUrl}`
  } catch (e) {
    return location
  }
}

// 封装HTMLRewriter逻辑
function applyHTMLRewriter(response, target) {
  return new HTMLRewriter()
    .on('a', {
      element(el) {
        rewriteAttr(el, 'href', target)
      }
    })
    .on('img', {
      element(el) {
        rewriteAttr(el, 'src', target)
      }
    })
    .on('link', {
      element(el) {
        rewriteAttr(el, 'href', target)
      }
    })
    .on('script', {
      element(el) {
        rewriteAttr(el, 'src', target)
      }
    })
    .on('form', {
      element(el) {
        rewriteAttr(el, 'action', target)
      }
    })
    .on('base', {
      element(el) {
        rewriteAttr(el, 'href', target)
      }
    })
    .on('meta[http-equiv="refresh"]', {
      element(el) {
        const content = el.getAttribute('content')
        if (content) {
          const parts = content.split(';')
          if (parts.length === 2) {
            const urlPart = parts[1].trim()
            if (urlPart.toLowerCase().startsWith('url=')) {
              const urlValue = urlPart.substring(4)
              const newUrl = rewriteAttributeValue(urlValue, target)
              el.setAttribute('content', `${parts[0]}; url=${newUrl}`)
            }
          }
        }
      }
    })
    .transform(response)
}

function rewriteAttr(el, attrName, target) {
  const val = el.getAttribute(attrName)
  if (val) {
    const newVal = rewriteAttributeValue(val, target)
    el.setAttribute(attrName, newVal)
  }
}

function rewriteAttributeValue(attrValue, target) {
  try {
    // 处理绝对路径和协议相对路径
    const url = new URL(attrValue, target)
    if (!/^https?:\/\//i.test(url.href)) {
      // 非http(s)协议的URL不处理
      return attrValue
    }
    const encodedUrl = encodeURIComponent(url.toString())
    return `/proxy/${encodedUrl}`
  } catch (e) {
    // 如果无法解析，返回原值
    return attrValue
  }
}

function rewriteInlineJS(html, target, proxyOrigin) {
  const absolutePatterns = [
    /(window\.location\s*=\s*)(['"])(https?:\/\/[^'"]+)/gi,
    /(location\.href\s*=\s*)(['"])(https?:\/\/[^'"]+)/gi,
    /(window\.open\s*\(\s*)(['"])(https?:\/\/[^'"]+)/gi,
    /(document\.location\s*=\s*)(['"])(https?:\/\/[^'"]+)/gi
  ]

  for (const p of absolutePatterns) {
    html = html.replace(p, (match, prefix, quote, origUrl) => {
      const newUrl = `${proxyOrigin}/proxy/${encodeURIComponent(origUrl)}`
      return `${prefix}${quote}${newUrl}${quote}`
    })
  }

  // 处理相对路径的跳转
  const relativePatterns = [
    /(window\.location\s*=\s*)(['"])(\/[^'"]+)/gi,
    /(location\.href\s*=\s*)(['"])(\/[^'"]+)/gi,
    /(window\.open\s*\(\s*)(['"])(\/[^'"]+)/gi,
    /(document\.location\s*=\s*)(['"])(\/[^'"]+)/gi
  ]

  for (const p of relativePatterns) {
    html = html.replace(p, (match, prefix, quote, origPath) => {
      try {
        const absoluteUrl = new URL(origPath, target)
        const newUrl = `${proxyOrigin}/proxy/${encodeURIComponent(absoluteUrl.toString())}`
        return `${prefix}${quote}${newUrl}${quote}`
      } catch (e) {
        return match
      }
    })
  }

  return html
}

function injectFakeEnvScript(html, target, proxyOrigin) {
  const fakeHost = target.host
  const fakeOrigin = target.origin
  const fakeProtocol = target.protocol

  const script = `
<script>
(function(){
  // 伪造window.location关键属性
  Object.defineProperty(window.location, 'hostname', { get: () => "${fakeHost}" });
  Object.defineProperty(window.location, 'host', { get: () => "${fakeHost}" });
  Object.defineProperty(window.location, 'origin', { get: () => "${fakeOrigin}" });
  Object.defineProperty(window.location, 'protocol', { get: () => "${fakeProtocol}" });

  // 伪造document.domain访问
  Object.defineProperty(document, 'domain', {
    get: () => "${fakeHost}",
    set: () => {}
  });

  // 劫持document.cookie访问
  const originalCookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') ||
    Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie');

  Object.defineProperty(document, 'cookie', {
    get() {
      return originalCookieDescriptor.get.call(document);
    },
    set(value) {
      return originalCookieDescriptor.set.call(document, value);
    }
  });

  // 拦截window.location.assign和replace
  const originalAssign = window.location.assign;
  window.location.assign = function(url) {
    if (typeof url === 'string') {
      const newUrl = "${proxyOrigin}/proxy/" + encodeURIComponent(new URL(url, window.location.origin).toString());
      return originalAssign.call(window.location, newUrl);
    }
    return originalAssign.call(window.location, url);
  };

  const originalReplace = window.location.replace;
  window.location.replace = function(url) {
    if (typeof url === 'string') {
      const newUrl = "${proxyOrigin}/proxy/" + encodeURIComponent(new URL(url, window.location.origin).toString());
      return originalReplace.call(window.location, newUrl);
    }
    return originalReplace.call(window.location, url);
  };

  // 拦截history.pushState和replaceState
  const originalPushState = history.pushState;
  history.pushState = function(state, title, url) {
    if (typeof url === 'string') {
      const newUrl = "/proxy/" + encodeURIComponent(new URL(url, window.location.origin).toString());
      return originalPushState.call(history, state, title, newUrl);
    }
    return originalPushState.call(history, state, title, url);
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function(state, title, url) {
    if (typeof url === 'string') {
      const newUrl = "/proxy/" + encodeURIComponent(new URL(url, window.location.origin).toString());
      return originalReplaceState.call(history, state, title, newUrl);
    }
    return originalReplaceState.call(history, state, title, url);
  };
})();
</script>
  `
  // 注入脚本到 </head> 前
  return html.replace(/<\/head>/i, script + '</head>') || (script + html)
}
