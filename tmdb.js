const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Pragma': 'no-cache',
};

const TMDB_BASE = 'https://api.themoviedb.org/3';
const IMG_BASE  = 'https://image.tmdb.org/t/p';

async function tmdb(path, key) {
  // Build URL carefully - don't encode the dots in param names
  const separator = path.includes('?') ? '&' : '?';
  const url = TMDB_BASE + path + separator + 'api_key=' + key;
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error('TMDB ' + res.status + ': ' + path + ' -> ' + text.slice(0, 200));
  return JSON.parse(text);
}

// Map TMDB genre IDs to names
const GENRE_MAP = {
  28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',
  99:'Documentary',18:'Drama',10751:'Family',14:'Fantasy',36:'History',
  27:'Horror',10402:'Music',9648:'Mystery',10749:'Romance',878:'Sci-Fi',
  10770:'TV Movie',53:'Thriller',10752:'War',37:'Western',
  10759:'Action & Adventure',10762:'Kids',10763:'News',10764:'Reality',
  10765:'Sci-Fi & Fantasy',10766:'Soap',10767:'Talk',10768:'War & Politics',
};

// Streaming service name map
const PROVIDER_URLS = {
  'Netflix':        'https://www.netflix.com/search?q=',
  'Disney Plus':    'https://www.disneyplus.com/search/',
  'Max':            'https://play.max.com/search?q=',
  'Hulu':           'https://www.hulu.com/search?q=',
  'Apple TV Plus':  'https://tv.apple.com/search?term=',
  'Peacock':        'https://www.peacocktv.com/search?q=',
  'Paramount Plus': 'https://www.paramountplus.com/search/',
  'Amazon Prime Video': 'https://www.amazon.com/s?k=',
  'Tubi':           'https://tubitv.com/search/',
};

function providerLink(name, title) {
  const base = PROVIDER_URLS[name];
  return base ? base + encodeURIComponent(title) : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const KEY = process.env.TMDB_API_KEY;
  if (!KEY) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'TMDB not configured.' }),
    };
  }

  const params = event.queryStringParameters || {};
  const action = params.action;
  const title  = params.title;
  const id     = params.id;
  const media  = params.media || 'movie';
  const era    = params.era  || 'any';
  const type   = params.type || 'both';

  try {
    // ── SEARCH: find a title ──
    if (action === 'search') {
      const data = await tmdb(`/search/multi?query=${encodeURIComponent(title)}&include_adult=false`, KEY);
      const result = data.results?.find(r => r.media_type === 'movie' || r.media_type === 'tv');
      if (!result) return { statusCode: 404, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Not found' }) };
      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: result.id, media_type: result.media_type }),
      };
    }

    // ── DETAIL: full info for a known id ──
    if (action === 'detail' && id) {
      const endpoint = media === 'tv' ? `/tv/${id}` : `/movie/${id}`;
      const [detail, credits, videos, providers, extIds] = await Promise.all([
        tmdb(`${endpoint}?append_to_response=release_dates,content_ratings`, KEY),
        tmdb(`${endpoint}/credits`, KEY),
        tmdb(`${endpoint}/videos`, KEY),
        tmdb(`${endpoint}/watch/providers`, KEY),
        tmdb(`${endpoint}/external_ids`, KEY),
      ]);

      // Poster & backdrop
      const poster   = detail.poster_path   ? `${IMG_BASE}/w500${detail.poster_path}`   : null;
      const backdrop = detail.backdrop_path ? `${IMG_BASE}/w1280${detail.backdrop_path}` : null;

      // Year
      const rawDate = media === 'tv' ? detail.first_air_date : detail.release_date;
      const year = rawDate ? rawDate.slice(0, 4) : null;
      const endYear = media === 'tv' && detail.last_air_date && detail.status !== 'Returning Series'
        ? detail.last_air_date.slice(0, 4) : null;
      const yearDisplay = media === 'tv'
        ? (endYear && endYear !== year ? `${year}–${endYear}` : `${year}–`)
        : year;

      // Genres
      const genre = (detail.genres || []).map(g => g.name).slice(0, 2).join(', ');

      // Runtime
      let runtime = null;
      if (media === 'movie' && detail.runtime) {
        const h = Math.floor(detail.runtime / 60);
        const m = detail.runtime % 60;
        runtime = h > 0 ? `${h}h ${m}m` : `${m}m`;
      } else if (media === 'tv' && detail.episode_run_time?.[0]) {
        runtime = `${detail.episode_run_time[0]} min/episode`;
      }

      // US content rating
      let rating = null;
      if (media === 'movie') {
        const us = detail.release_dates?.results?.find(r => r.iso_3166_1 === 'US');
        rating = us?.release_dates?.find(r => r.certification)?.certification || null;
      } else {
        const us = detail.content_ratings?.results?.find(r => r.iso_3166_1 === 'US');
        rating = us?.rating || null;
      }

      // Trailer — prefer official YouTube trailer
      const trailerVideo = (videos.results || []).find(v =>
        v.site === 'YouTube' && v.type === 'Trailer' && v.official
      ) || (videos.results || []).find(v =>
        v.site === 'YouTube' && v.type === 'Trailer'
      );
      const trailerId = trailerVideo?.key || null;

      // Streaming (US)
      const usProviders = providers.results?.US?.flatrate || [];
      const streaming = usProviders.slice(0, 6).map(p => ({
        name: p.provider_name,
        logo: `${IMG_BASE}/w45${p.logo_path}`,
        url: providerLink(p.provider_name, detail.title || detail.name) || `https://www.justwatch.com/us/search?q=${encodeURIComponent(detail.title || detail.name)}`,
      }));

      // Cast
      const cast = (credits.cast || []).slice(0, 6).map(c => c.name);

      // Director / creator
      const director = media === 'movie'
        ? (credits.crew || []).find(c => c.job === 'Director')?.name
        : (detail.created_by || []).map(c => c.name).join(', ');

      // IMDb id for linking
      const imdbId = extIds.imdb_id || null;

      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: detail.id,
          media_type: media,
          title: detail.title || detail.name,
          year: yearDisplay,
          genre,
          runtime,
          rating,
          synopsis: detail.overview || null,
          poster,
          backdrop,
          imdb_id: imdbId,
          imdb_link: imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,
          vote_average: detail.vote_average ? detail.vote_average.toFixed(1) : null,
          vote_count: detail.vote_count || null,
          trailer_id: trailerId,
          streaming,
          cast,
          director: director || null,
          tagline: detail.tagline || null,
        }),
      };
    }

    // ── BROWSE: filter-aware poster rows ──
    if (action === 'trending') {

      // Map era to TMDB date range
      const eraRanges = {
        'pre70': { gte: '1900-01-01', lte: '1969-12-31' },
        '70s':   { gte: '1970-01-01', lte: '1979-12-31' },
        '80s':   { gte: '1980-01-01', lte: '1989-12-31' },
        '90s':   { gte: '1990-01-01', lte: '1999-12-31' },
        '2000s': { gte: '2000-01-01', lte: '2009-12-31' },
        '2010s': { gte: '2010-01-01', lte: '2019-12-31' },
        '2020s': { gte: '2020-01-01', lte: '2025-12-31' },
        'new':   { gte: '2026-01-01', lte: '2026-12-31' },
      };

      const mapItem = (item, mediaType) => ({
        id: item.id,
        media_type: mediaType,
        title: item.title || item.name,
        year: (item.release_date || item.first_air_date || '').slice(0, 4),
        poster: item.poster_path ? `${IMG_BASE}/w342${item.poster_path}` : null,
        vote_average: item.vote_average?.toFixed(1) || null,
      });

      const range = eraRanges[era];

      // Build TMDB endpoints based on era and type filters
      let movieEndpoint, showEndpoint;

      console.log('ERA VALUE:', era, 'RANGE:', JSON.stringify(range));
      if (range) {
        // Use discover for era-filtered results
        movieEndpoint = '/discover/movie?sort_by=popularity.desc&primary_release_date.gte=' + range.gte + '&primary_release_date.lte=' + range.lte + '&vote_count.gte=50';
        showEndpoint  = '/discover/tv?sort_by=popularity.desc&first_air_date.gte=' + range.gte + '&first_air_date.lte=' + range.lte + '&vote_count.gte=20';
      } else {
        // Default: now playing / on air
        movieEndpoint = '/movie/now_playing?region=US&page=1';
        showEndpoint  = '/tv/on_the_air?page=1';
      }
      console.log('MOVIE ENDPOINT:', movieEndpoint);

      const fetchMovies = type !== 'tv'  ? tmdb(movieEndpoint, KEY) : Promise.resolve({ results: [] });
      const fetchShows  = type !== 'movie' ? tmdb(showEndpoint, KEY)  : Promise.resolve({ results: [] });

      const [movies, shows] = await Promise.all([fetchMovies, fetchShows]);

      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          debug: { era: era, type: type, hasRange: !!range, movieEndpoint: movieEndpoint },
          movies: (movies.results || []).slice(0, 4).map(i => mapItem(i, 'movie')),
          shows:  (shows.results  || []).slice(0, 4).map(i => mapItem(i, 'tv')),
        }),
      };
    }

    return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unknown action.' }) };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
