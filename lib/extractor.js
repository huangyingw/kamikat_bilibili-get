var qs = require('qs');
var debug = require('debug').debug('bilibili:extractor');
var playUrl = require('bilibili-playurl');
var axios = require('axios').create({
  headers: {
    common: {
      'User-Agent': "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/63.0.3239.132 Safari/537.36"
    }
  }
});

var REGEX_URL_VIDEO    = /^https?:\/\/(?:www\.|bangumi\.|)bilibili\.(?:tv|com)\/(?:video\/av(\d+)(?:\/index_(\d+)\.html|\/)?)(?:\?.*)?$/i;
var REGEX_URL_BGM      = /^https?:\/\/(?:www\.|bangumi\.|)bilibili\.(?:tv|com)\/(?:anime\/(\d+)\/play#|bangumi\/play\/ep)(\d+)\/?(?:\?.*)?$/i;
var REGEX_URL_BGM_LIST = /^https?:\/\/(?:www\.|bangumi\.|)bilibili\.(?:tv|com)\/(?:anime\/(\d+)(?:\/play|\/|)|bangumi\/play\/ss(\d+)\/?)(?:\?.*)?$/i;

var parseUrl = function* (url) {
  var type = [ REGEX_URL_VIDEO, REGEX_URL_BGM, REGEX_URL_BGM_LIST ].reverse().reduce((m, regex) => m << 1 | + regex.test(url), 0);
  if (type <= 1) {
    var resp = yield axios.head(url)
      , _url = resp.request.res.responseUrl || url;
    if (_url != url) {
      debug(`redirected to ${url}`);
      return yield parseUrl(_url);
    } else if (type === 0) {
      throw new Error(`${url} is an invalid url.`)
    }
  }
  return Object.assign({
    url: url,
    type: type
  }, type === 1 && {
    video_id: parseInt(REGEX_URL_VIDEO.exec(url)[1]),
    part_id: parseInt(REGEX_URL_VIDEO.exec(url)[2])
  }, type === 2 && {
    bangumi_id: parseInt(REGEX_URL_BGM.exec(url)[1]),
    episode_id: parseInt(REGEX_URL_BGM.exec(url)[2])
  }, type === 4 && {
    bangumi_id: parseInt(REGEX_URL_BGM_LIST.exec(url)[1])
  });
};

var fetchWebPage = function* (url) {
  debug('fetching webpage...');
  var { data } = yield axios.get(url);
  debug('fetching webpage... done');
  return data;
}

var findVideoInfo = function* ({ video_id, part_id }) {
  debug(`extracting video info...`);
  var data = yield fetchWebPage(`https://www.bilibili.com/video/av${video_id}/` + (part_id ? `index_${part_id}.html` : ''));
  var videoInfo = Object.assign({
    info: {
      title: /<h1 [^>]*title="([^"]*)/.exec(data)[1],
      creator: /<a [^>]*card="([^"]*)/.exec(data)[1],
      creator_id: /<a [^>]*mid="([^"]*)/.exec(data)[1],
      created_at: /<time [^>]*datetime="([^"]+)/.exec(data)[1],
    },
    parts: (function (parts) {
      debug('extracting part info...');
      if (/<div id="plist"><\//.test(data)) {
        var cid = /cid=(\d+)/.exec(data)[1]
        debug(`cid found ${cid}`);
        parts.push({
          aid: video_id,
          cid: parseInt(cid),
          part_id: 1,
          index: '1'
        })
      } else {
        var i = /<option[^>]*cid='(\d+)[^>]*>(\d+)、([^<]*)/g, match;
        while (match = i.exec(data)) {
          parts.push({
            aid: video_id,
            cid: parseInt(match[1]),
            part_id: parseInt(match[2]),
            index: match[2],
            index_title: match[3]
          });
          debug(`cid #${match[2]} found ${match[1]}`);
        }
      }
      return parts;
    })([])
  });
  debug(`extracting video info... done`);
  return videoInfo;
};

var findBangumiInfo = function* ({ url, bangumi_id }) {
  var data = yield fetchWebPage(bangumi_id ? `https://bangumi.bilibili.com/anime/${bangumi_id}/play` : url);
  var json = JSON.parse(/window.__INITIAL_STATE__=([^;]*)/.exec(data)[1]);
  var videoInfo = Object.assign({
    info: {
      title: json.mediaInfo.title,
      creator: json.upInfo.uname,
      creator_id: json.upInfo.mid,
      publish_at: json.pubInfo.pub_time,
    },
    season_type: json.mediaInfo.season_type,
    parts: json.epList.map(({ aid, cid, index_title, ep_id, index }) => ({
      aid, cid, index, index_title, episode_id: ep_id
    }))
  });
  return videoInfo;
};

var findCidByEpisodeId = function* ({ url, episode_id }) {
  debug('fetching source info...');
  var { data } = yield axios.post('http://bangumi.bilibili.com/web_api/get_source', qs.stringify({ episode_id }), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': url
    }
  });
  debug('fetching source info... done');
  var json = data.result || {};
  if (!json.cid) {
    throw new Error('Cannot get cid from source information.');
  }
  debug(`cid found ${json.cid}`);
  return json.cid;
};

var fetchPlayInfo = function* ({ cid, quality, season_type, cookie }) {
  var url = yield playUrl(cid, { quality, season_type });
  debug(`requesting playurl ${url}...`)
  var { data } = yield axios.get(url, cookie ? {
    headers: { 'Cookie': cookie }
  } : {});
  debug(`requesting playurl... done`);
  debug(data);
  if (data.code) {
    throw new Error(`cannot get play info, server message: "${data.message}"`);
  }
  return data;
};

module.exports = {
  parseUrl, findBangumiInfo, findVideoInfo, findCidByEpisodeId, fetchPlayInfo
};