import express from 'express';
import axios from 'axios';
import fetch from 'node-fetch';
import NodeCache from 'node-cache';
import { getEmbedSu } from "./src/extractors/embedsu.js";

const app = express();
const PORT = 3000;
const tsCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// Middleware
app.use(express.json());

// Add CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  next();
});

// Simple status endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'online', 
    service: 'Stream Proxy Server',
    endpoints: {
      viperProxy: '/viper-proxy/:url(*)',
      proxyStream: '/proxy-stream/:url(*)',
      status: '/status',
      clearCache: '/clear-cache',
      embedSu: {
        movie: "/embedsu/:movieTMDBid",
        show: "/embedsu/:showTMDBid?s=seasonNumber&e=episodeNumber"
      }
    }
  });
});

// Status endpoint with cache stats
app.get('/status', (req, res) => {
  const stats = tsCache.getStats();
  res.json({
    status: 'online',
    cacheStats: {
      keys: tsCache.keys().length,
      hits: stats.hits,
      misses: stats.misses,
      ksize: stats.ksize,
      vsize: stats.vsize
    },
    uptime: process.uptime()
  });
});

// Clear cache endpoint
app.post('/clear-cache', (req, res) => {
  const token = req.body.token;
  
  // Simple token validation - in production use a more secure method
  if (token !== process.env.ADMIN_TOKEN && token !== 'admin-token') {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  
  const keysCount = tsCache.keys().length;
  tsCache.flushAll();
  
  res.json({ 
    success: true, 
    message: `Cache cleared. ${keysCount} TS segments removed.` 
  });
});

// Direct proxy stream route
app.get('/proxy-stream/:url(*)', async (req, res) => {
  const streamUrl = req.params.url;
  
  if (!streamUrl) {
    return res.status(400).json({ error: 'Stream URL is required' });
  }
  
  try {
    // Check if we have the TS segment or file in cache
    if (streamUrl.endsWith('.jpg') || streamUrl.endsWith('.html') || streamUrl.endsWith('.ts')) {
      const cachedContent = tsCache.get(streamUrl);
      
      if (cachedContent) {
        console.log(`Serving cached content for: ${streamUrl}`);
        
        // Set the content type from cached metadata
        if (cachedContent.contentType) {
          res.setHeader('Content-Type', cachedContent.contentType);
        }
        
        // Return the cached buffer
        return res.send(cachedContent.data);
      }
    }
    
    // Not in cache, fetch from source
    console.log(`Fetching from source: ${streamUrl}`);
    
    // Use the specific headers required
    const headers = {
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'origin': 'https://embed.su',
      'priority': 'u=1, i',
      'referer': 'https://embed.su/',
      'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Microsoft Edge";v="134"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'cross-site',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0'
    };

    const response = await fetch(streamUrl, { headers });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }
    
    // Get content type and set response header
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }
    
    // For m3u8 files we rewrite the content but don't cache it
    if (streamUrl.endsWith('m3u8')) {
      const data = await response.text();
      
      // Rewrite the content to use our proxy for internal URLs
      const rewrittenData = rewriteM3u8ContentDirect(data);
      
      // Send the rewritten response
      return res.send(rewrittenData);
    } 
    // For TS segment files, jpg, or html files, cache the binary data
    else if (streamUrl.endsWith('.jpg') || streamUrl.endsWith('.html') || streamUrl.endsWith('.ts')) {
      const buffer = await response.buffer();
      
      // Cache the buffer
      tsCache.set(streamUrl, {
        data: buffer,
        contentType: contentType
      });
      
      // Send the response
      return res.send(buffer);
    }
    // For other content, we stream directly without caching
    else {
      // Stream the response data to the client
      response.body.pipe(res);
    }
  } catch (error) {
    console.error('Proxy stream error:', error);
    res.status(500).json({ error: 'Failed to proxy stream: ' + error.message });
  }
});

// Viper proxy route that transforms URLs
app.get('/viper-proxy/:url(*)', async (req, res) => {
  const originalUrl = req.params.url;
  
  if (!originalUrl) {
    return res.status(400).json({ error: 'Stream URL is required' });
  }

  // Transform the URL to the required format
  // From: https://stormyclouds42.xyz/file2/...
  // To: https://embed.su/api/proxy/viper/stormyclouds42.xyz/file2/...
  let transformedUrl;
  
  try {
    const urlObj = new URL(originalUrl);
    const hostname = urlObj.hostname;
    const pathname = urlObj.pathname;
    const search = urlObj.search;
    
    // Create the transformed URL
    transformedUrl = `https://embed.su/api/proxy/viper/${hostname}${pathname}${search}`;
    
    console.log(`Original URL: ${originalUrl}`);
    console.log(`Transformed URL: ${transformedUrl}`);
  } catch (error) {
    return res.status(400).json({ error: 'Invalid URL format: ' + error.message });
  }
  
  try {
    // Check if we have the TS segment in cache
    if (originalUrl.endsWith('.ts') || originalUrl.endsWith('.jpg') || originalUrl.endsWith('.html')) {
      const cachedSegment = tsCache.get(originalUrl);
      
      if (cachedSegment) {
        console.log(`Serving cached segment for: ${originalUrl}`);
        
        // Set the content type from cached metadata
        if (cachedSegment.contentType) {
          res.setHeader('Content-Type', cachedSegment.contentType);
        }
        
        // Return the cached buffer
        return res.send(cachedSegment.data);
      }
    }
    
    // Not in cache or not a TS file, fetch from source
    console.log(`Fetching from source: ${transformedUrl}`);
    
    // Use the specific headers required
    const headers = {
      'accept': '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'priority': 'u=1, i',
      'referer': 'https://embed.su/',
      'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Microsoft Edge";v="134"',
      'sec-ch-ua-arch': '"x86"',
      'sec-ch-ua-bitness': '"64"',
      'sec-ch-ua-full-version': '"134.0.3124.72"',
      'sec-ch-ua-full-version-list': '"Chromium";v="134.0.6998.89", "Not:A-Brand";v="24.0.0.0", "Microsoft Edge";v="134.0.3124.72"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-model': '""',
      'sec-ch-ua-platform': '"Windows"',
      'sec-ch-ua-platform-version': '"19.0.0"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0'
    };

    const response = await fetch(transformedUrl, { headers });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
    }
    
    // Get content type and set response header
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.setHeader('Content-Type', contentType);
    }
    
    // For m3u8 files we rewrite the content but don't cache it
    if (originalUrl.endsWith('m3u8')) {
      const data = await response.text();
      
      // Rewrite the content to use our proxy for internal URLs
      const rewrittenData = rewriteM3u8ContentDirect(data);
      
      // Send the rewritten response
      return res.send(rewrittenData);
    } 
    // For TS segment files, cache the binary data
    else if (originalUrl.endsWith('.ts') || originalUrl.endsWith('.jpg') || originalUrl.endsWith('.html')) {
      const buffer = await response.buffer();
      
      // Cache the buffer
      tsCache.set(originalUrl, {
        data: buffer,
        contentType: contentType
      });
      
      // Send the response
      return res.send(buffer);
    }
    // For other content, we stream directly without caching
    else {
      // Stream the response data to the client
      response.body.pipe(res);
    }
  } catch (error) {
    console.error('Proxy stream error:', error);
    res.status(500).json({ error: 'Failed to proxy stream: ' + error.message });
  }
});

// New EmbedSu Routes
app.get('/embedsu/:tmdbId', async (req, res) => {
  const id = req.params.tmdbId;
  const season = req.query.s;
  const episode = req.query.e;
  
  try {
    if (season && episode) {
      const vidsrcresponse = await getEmbedSu(id, season, episode);
      res.status(200).json(vidsrcresponse);
    } else {
      const vidsrcresponse = await getEmbedSu(id);
      res.status(200).json(vidsrcresponse);
    }
  } catch (error) {
    console.error('Error fetching data:', error);
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

// Empty route for vidsr-net (placeholder as shown in your code)
app.get('/vidsr-net/:tmdbid', async (req, res) => {
  // This route is a placeholder as provided in your code
  res.status(501).json({ message: "Not implemented yet" });
});

// Helper function to rewrite m3u8 content to directly use our proxy
function rewriteM3u8ContentDirect(content) {
  // Replace all full URLs with our proxy URL
  // This specifically targets lines that start with https:// and aren't comments
  return content.replace(/(^https:\/\/.*$)/gm, (match) => {
    if (!match.startsWith('#')) {
      return `/proxy-stream/${match}`;
    }
    return match;
  });
}

// Original helper function to rewrite m3u8 content using URL context
function rewriteM3u8Content(content, originalUrl) {
  // Get the base URL for relative paths in the m3u8 file
  let baseUrl = '';
  try {
    const urlObj = new URL(originalUrl);
    const pathParts = urlObj.pathname.split('/');
    pathParts.pop(); // Remove the file name
    const basePath = pathParts.join('/');
    baseUrl = `${urlObj.protocol}//${urlObj.host}${basePath}/`;
  } catch (e) {
    console.error('Error parsing original URL:', e);
  }
  
  // Rewrite segment URLs to go through our proxy
  return content.replace(/^((?!#).+\.ts|.+\.m3u8|.+\.jpg|.+\.html)$/gm, function(match) {
    // Handle absolute URLs, URLs starting with /, and relative URLs
    let absoluteUrl;
    if (match.startsWith('http')) {
      absoluteUrl = match;
    } else if (match.startsWith('/')) {
      try {
        const urlObj = new URL(originalUrl);
        absoluteUrl = `${urlObj.protocol}//${urlObj.host}${match}`;
      } catch (e) {
        return match; // If we can't parse, return the original
      }
    } else {
      absoluteUrl = baseUrl + match;
    }
    
    return `/proxy-stream/${absoluteUrl}`;
  });
}

app.listen(PORT, () => {
  console.log(`Stream Proxy Server running on http://localhost:${PORT}`);
  console.log(`Available endpoints:`);
  console.log(`  - GET /                    : Service info`);
  console.log(`  - GET /status              : Service status with cache stats`);
  console.log(`  - GET /proxy-stream/:url   : Direct proxy stream endpoint`);
  console.log(`  - GET /viper-proxy/:url    : Viper proxy endpoint with URL transformation`);
  console.log(`  - GET /embedsu/:tmdbId     : EmbedSu movie/show lookup endpoint`);
  console.log(`  - POST /clear-cache        : Clear cache (requires token)`);
  console.log(`TS segments are cached for 10 minutes. M3U8 files are not cached.`);
  console.log(`CORS enabled for all origins`);
});