<#
.SYNOPSIS
  Local backend for "Chords for All" -- serves the static app plus /api/search and /api/fetch,
  implementing real Ultimate Guitar + tab4u.com search/scrape (the original app assumed these
  existed; they never did anywhere until this file). No Node/Python on this machine, so this is
  plain Windows PowerShell + System.Net.HttpListener.

  Reverse-engineered 2026-09-21 by fetching real pages and inspecting them directly:

  Ultimate Guitar: every page (search results AND individual tab pages) embeds a big HTML-entity
  -encoded JSON blob in `<div class="js-store" data-content="...">`. For a search results page
  (https://www.ultimate-guitar.com/search.php?search_type=title&value=<q>), that JSON's
  `store.page.data.results` array holds one entry per hit; we keep entries with
  `type -eq 'Chords'` and `tab_access_type -eq 'public'` (marketing/Pro entries point at
  paywalled app links, not usable tab_urls). For a tab page (the `tab_url` from a search hit,
  e.g. https://tabs.ultimate-guitar.com/tab/oasis/wonderwall-chords-6125), the same JSON's
  `store.page.data.tab.song_name` / `.artist_name` and `store.page.data.tab_view.wiki_tab.content`
  give the metadata and the raw chord/lyric text -- already in `[ch]Chord[/ch]` /
  `[tab]...[/tab]` markup, which app.js's `stripUGTags` already expects, unchanged since it was
  clearly written against this exact source.

  tab4u.com: search (https://www.tab4u.com/resultsSimple?tab=1&q=<q>) returns an HTML page whose
  result rows are `<a href="tabs/songs/<id>_<slug>.html" ...><div class="sNameI19">Title /</div>
  <div class="aNameI19">Artist</div></a>` -- title/artist plus the relative URL come straight out
  of that. A song page's chords/lyrics live in `<div id="songContentTPL">`, a sequence of
  `<table>` blocks each with `<tr><td class="chords">...</td></tr>` (one `<span>` per chord,
  positioned by leading/interleaved `&nbsp;` runs) alternating with
  `<tr><td class="song">...</td></tr>` (the lyric line, `&nbsp;` again standing in for spaces).
  Replacing each chord `<span>...Name...</span>` with literal `[Name]` and decoding every
  `&nbsp;` (-> U+00A0 after HtmlDecode) to a plain space reproduces -- character-for-character,
  verified against this repo's own previously-saved favorites -- the same whitespace-positioned
  `[Chord]lyric` bracket format the manual-entry parser in app.js already understands. The page's
  own <title> is "אקורדים לשיר <Song> - <Artist> | Tab4U", which is where title/artist for a
  fetched song come from (a "paste a link" tab4u URL has no search-result metadata to reuse).

.USAGE
  powershell -File server.ps1 [-Port 8787]
  Then, to expose it publicly: devtunnel host -p 8787 --allow-anonymous
#>
param([int]$Port = 8787)

Add-Type -AssemblyName System.Web
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = $PSScriptRoot
$ugHeaders = @{ 'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }

function Send-Json($response, $obj, [int]$status = 200) {
    $json = $obj | ConvertTo-Json -Depth 10 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $response.StatusCode = $status
    $response.ContentType = 'application/json; charset=utf-8'
    $response.ContentLength64 = $bytes.Length
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
    $response.OutputStream.Close()
}

function Send-StaticFile($response, [string]$path, [string]$contentType) {
    if (-not (Test-Path $path)) { $response.StatusCode = 404; $response.OutputStream.Close(); return }
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $response.ContentType = $contentType
    $response.ContentLength64 = $bytes.Length
    $response.OutputStream.Write($bytes, 0, $bytes.Length)
    $response.OutputStream.Close()
}

function Get-JsStoreJson([string]$html) {
    $m = [regex]::Match($html, 'data-content="([^"]+)"')
    if (-not $m.Success) { return $null }
    $decoded = [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value)
    try { return $decoded | ConvertFrom-Json } catch { return $null }
}

function Get-UGSearchResults([string]$q) {
    $url = 'https://www.ultimate-guitar.com/search.php?search_type=title&value=' + [System.Uri]::EscapeDataString($q)
    try { $resp = Invoke-WebRequest -Uri $url -Headers $ugHeaders -UseBasicParsing -TimeoutSec 15 } catch { return @() }
    $json = Get-JsStoreJson $resp.Content
    if (-not $json) { return @() }
    $hits = $json.store.page.data.results | Where-Object { $_.type -eq 'Chords' -and $_.tab_access_type -eq 'public' -and $_.tab_url }
    $out = @()
    foreach ($r in $hits) {
        $out += [pscustomobject]@{
            title      = $r.song_name
            artist     = $r.artist_name
            url        = $r.tab_url
            source     = 'ultimate-guitar'
            rating     = if ($r.rating) { [math]::Round([double]$r.rating, 2) } else { $null }
            votes      = $r.votes
            difficulty = $r.difficulty
        }
    }
    return $out | Select-Object -First 10
}

function Get-UGFetch([string]$tabUrl) {
    try { $resp = Invoke-WebRequest -Uri $tabUrl -Headers $ugHeaders -UseBasicParsing -TimeoutSec 15 } catch { return $null }
    $json = Get-JsStoreJson $resp.Content
    if (-not $json) { return $null }
    $content = $json.store.page.data.tab_view.wiki_tab.content
    if (-not $content) { return $null }
    return [pscustomobject]@{
        title  = $json.store.page.data.tab.song_name
        artist = $json.store.page.data.tab.artist_name
        raw    = $content
        source = 'ultimate-guitar'
    }
}

function Get-Tab4uSearchResults([string]$q) {
    $url = 'https://www.tab4u.com/resultsSimple?tab=1&q=' + [System.Uri]::EscapeDataString($q)
    try { $resp = Invoke-WebRequest -Uri $url -Headers $ugHeaders -UseBasicParsing -TimeoutSec 15 } catch { return @() }
    $rowMatches = [regex]::Matches($resp.Content,
        'href="(tabs/songs/[^"]+\.html)"[^>]*>.*?<div class="sNameI19">([^<]*?)\s*/?\s*</div>\s*<div class="aNameI19">([^<]*)</div>')
    $out = @()
    foreach ($mm in $rowMatches) {
        $href = [System.Net.WebUtility]::HtmlDecode($mm.Groups[1].Value)
        $out += [pscustomobject]@{
            title  = [System.Net.WebUtility]::HtmlDecode($mm.Groups[2].Value).Trim()
            artist = [System.Net.WebUtility]::HtmlDecode($mm.Groups[3].Value).Trim()
            url    = 'https://www.tab4u.com/' + $href
            source = 'tab4u'
        }
    }
    return $out | Select-Object -First 10
}

function Convert-Tab4uRow([string]$html) {
    $withBrackets = [regex]::Replace($html, '<span[^>]*>([^<]*)</span>', '[$1]')
    $noTags = [regex]::Replace($withBrackets, '<[^>]+>', '')
    $decoded = [System.Net.WebUtility]::HtmlDecode($noTags)
    return $decoded -replace [char]0xA0, ' '
}

function Get-Tab4uFetch([string]$songUrl) {
    try { $resp = Invoke-WebRequest -Uri $songUrl -Headers $ugHeaders -UseBasicParsing -TimeoutSec 15 } catch { return $null }
    $content = $resp.Content
    $startIdx = $content.IndexOf('id="songContentTPL"')
    if ($startIdx -lt 0) { return $null }
    $endIdx = $content.IndexOf('id="repliesWrapper"', $startIdx)
    if ($endIdx -lt 0) { $endIdx = $content.Length }
    $section = $content.Substring($startIdx, $endIdx - $startIdx)

    $lines = New-Object System.Collections.Generic.List[string]
    $rowMatches = [regex]::Matches($section, '<td class="(?:chords|song)">(.*?)</td>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    foreach ($rm in $rowMatches) { [void]$lines.Add((Convert-Tab4uRow $rm.Groups[1].Value)) }
    $raw = ($lines -join "`n")
    if (-not $raw.Trim()) { return $null }

    # Page <title> is "<two Hebrew words: 'Chords for the song'> <Song> - <Artist> | Tab4U" --
    # split structurally (word count / ASCII markers) rather than embedding the Hebrew prefix as
    # a literal in this regex, since a source-file encoding mismatch silently broke that match.
    $title = $null; $artist = $null
    $titleMatch = [regex]::Match($content, '<title>(.*?)</title>')
    if ($titleMatch.Success) {
        $t = [System.Net.WebUtility]::HtmlDecode($titleMatch.Groups[1].Value.Trim())
        $t = $t -replace '\s*\|\s*Tab4U\s*$', ''
        $parts = $t -split '\s+', 3
        $rest = if ($parts.Count -eq 3) { $parts[2] } else { $t }
        $dashIdx = $rest.LastIndexOf(' - ')
        if ($dashIdx -ge 0) {
            $title = $rest.Substring(0, $dashIdx).Trim()
            $artist = $rest.Substring($dashIdx + 3).Trim()
        } else {
            $title = $rest.Trim()
        }
    }
    return [pscustomobject]@{ title = $title; artist = $artist; raw = $raw; source = 'tab4u' }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Chords for All server running at http://localhost:$Port/  (Ctrl+C to stop)"

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $req = $context.Request
        $res = $context.Response
        $res.Headers.Add('Access-Control-Allow-Origin', '*')
        try {
            $path = $req.Url.AbsolutePath
            $qs = [System.Web.HttpUtility]::ParseQueryString($req.Url.Query)

            switch -Regex ($path) {
                '^/$|^/index\.html$' { Send-StaticFile $res (Join-Path $root 'index.html') 'text/html; charset=utf-8' }
                '^/app\.js$'         { Send-StaticFile $res (Join-Path $root 'app.js') 'application/javascript; charset=utf-8' }
                '^/style\.css$'      { Send-StaticFile $res (Join-Path $root 'style.css') 'text/css; charset=utf-8' }
                '^/api/search$' {
                    $q = $qs['q']
                    if (-not $q) { Send-Json $res @{ error = 'missing q parameter' } 400 }
                    else {
                        $all = @(Get-UGSearchResults $q) + @(Get-Tab4uSearchResults $q)
                        Send-Json $res @{ results = $all }
                    }
                }
                '^/api/fetch$' {
                    $u = $qs['url']
                    if (-not $u) { Send-Json $res @{ error = 'missing url parameter' } 400 }
                    else {
                        $result = $null
                        if ($u -match 'ultimate-guitar\.com') { $result = Get-UGFetch $u }
                        elseif ($u -match 'tab4u\.com') { $result = Get-Tab4uFetch $u }
                        else { Send-Json $res @{ error = 'Only Ultimate Guitar and tab4u.com links are supported.' } 400; continue }
                        if ($result) { Send-Json $res $result }
                        else { Send-Json $res @{ error = 'Could not load or parse that page -- the site may have changed its layout.' } 502 }
                    }
                }
                default { $res.StatusCode = 404; $res.OutputStream.Close() }
            }
        } catch {
            try { Send-Json $res @{ error = $_.Exception.Message } 500 } catch {}
        }
    }
} finally {
    $listener.Stop()
}
