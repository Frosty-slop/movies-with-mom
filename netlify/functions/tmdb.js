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
  const mood   = params.mood || 'any';

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
        logo: `${IMG_BASE}/w92${p.logo_path}`,
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

      // Map mood to TMDB genre IDs
      // Movies: 35=Comedy, 18=Drama, 10749=Romance, 28=Action, 12=Adventure,
      //         10751=Family, 36=History, 14=Fantasy, 10402=Music, 16=Animation
      // TV:     35=Comedy, 18=Drama, 10749=Romance, 10759=Action&Adventure,
      //         10751=Family, 36=History, 10762=Kids, 10767=Talk
      const moodMovieGenres = {
        // Uplifting, emotional, feel-good — any of: Family, Drama, Romance, Music
        'heartwarming': '10751%7C18%7C10749%7C10402',
        // Light and fun — Comedy or Family
        'funny':        '35%7C10751',
        // Adventure-forward, mom-safe — any of: Adventure, Fantasy, Animation, Action
        'exciting':     '12%7C14%7C16%7C28',
        // Gentle Sunday afternoon — any of: Romance, History, Music
        'cozy':         '10749%7C36%7C10402',
      };
      const moodTvGenres = {
        // Warm and uplifting — any of: Drama, Romance, Family
        'heartwarming': '18%7C10749%7C10751',
        // Light and fun — Comedy
        'funny':        '35',
        // Engaging but not dark — any of: Action & Adventure, Mystery, Drama
        'exciting':     '10759%7C9648%7C18',
        // Relaxed and gentle — any of: Romance, Drama, History
        'cozy':         '10749%7C18%7C36',
      };
      const movieGenreFilter = moodMovieGenres[mood] ? '&with_genres=' + moodMovieGenres[mood] : '';
      const tvGenreFilter    = moodTvGenres[mood]    ? '&with_genres=' + moodTvGenres[mood]    : '';

      // For cozy, explicitly exclude Action, Thriller, Horror, Crime, Science Fiction
      const moodMovieExclude = { 'cozy': '28,53,27,80,878' };
      const moodTvExclude    = { 'cozy': '10759,80,27,53'  };
      const movieExcludeFilter = moodMovieExclude[mood] ? '&without_genres=' + moodMovieExclude[mood] : '';
      const tvExcludeFilter    = moodTvExclude[mood]    ? '&without_genres=' + moodTvExclude[mood]    : '';

      const range = eraRanges[era];

      // Build TMDB endpoints based on era and type filters
      let movieEndpoint, showEndpoint;

      // Mom-safe ratings only
      // Movies: G, PG, PG-13 (no R or NC-17)
      // TV: TV-Y, TV-Y7, TV-G, TV-PG, TV-14 (no TV-MA)
      const momSafeMovieRatings = 'G,PG,PG-13';
      const momSafeTvRatings    = 'TV-Y,TV-Y7,TV-G,TV-PG,TV-14';

      // Only use without_genres on TV when no mood is selected (they conflict with with_genres)
      const tvKidsExclude = mood === 'any' ? '&without_genres=10762,16' : '';

      if (range) {
        // Use discover with certification filter for era-filtered results
        movieEndpoint = '/discover/movie?sort_by=popularity.desc&primary_release_date.gte=' + range.gte + '&primary_release_date.lte=' + range.lte + '&vote_count.gte=50&certification_country=US&certification.lte=PG-13&without_keywords=210024' + movieGenreFilter + movieExcludeFilter;
        showEndpoint  = '/discover/tv?sort_by=popularity.desc&first_air_date.gte=' + range.gte + '&first_air_date.lte=' + range.lte + '&vote_count.gte=20' + tvKidsExclude + '&without_keywords=210024' + tvGenreFilter + tvExcludeFilter;
      } else {
        // Default: now playing / on air — use discover so we can filter by rating
        movieEndpoint = '/discover/movie?sort_by=popularity.desc&primary_release_date.gte=2024-01-01&vote_count.gte=50&certification_country=US&certification.lte=PG-13&without_keywords=210024' + movieGenreFilter + movieExcludeFilter;
        showEndpoint  = '/discover/tv?sort_by=popularity.desc&first_air_date.gte=2024-01-01&vote_count.gte=20' + tvKidsExclude + '&without_keywords=210024' + tvGenreFilter + tvExcludeFilter;
      }

      const fetchMovies = type !== 'tv'    ? tmdb(movieEndpoint, KEY) : Promise.resolve({ results: [] });
      const fetchShows  = type !== 'movie' ? tmdb(showEndpoint,  KEY) : Promise.resolve({ results: [] });

      const [movies, shows] = await Promise.all([fetchMovies, fetchShows]);

      const ANIME_GENRE_T = 16;
      const safeMovies = (movies.results || [])
        .filter(i => !i.adult && i.original_language === 'en' && !(i.genre_ids || []).includes(ANIME_GENRE_T))
        .slice(0, 8)
        .map(i => mapItem(i, 'movie'));

      // Fetch content ratings for TV shows and filter out confirmed TV-MA
      const showResults = (shows.results || [])
        .filter(s => s.original_language === 'en' && !(s.genre_ids || []).includes(ANIME_GENRE_T))
        .slice(0, 20);
      const showRatings = await Promise.all(
        showResults.map(async show => {
          try {
            const details = await tmdb(`/tv/${show.id}/content_ratings`, KEY);
            const usRating = (details.results || []).find(r => r.iso_3166_1 === 'US');
            return { show, rating: usRating?.rating || null };
          } catch {
            return { show, rating: null }; // if rating fetch fails, include the show
          }
        })
      );

      // Only block shows explicitly rated TV-MA — shows with no rating are allowed through
      const safeShows = showRatings
        .filter(({ rating }) => rating !== 'TV-MA')
        .slice(0, 8)
        .map(({ show }) => mapItem(show, 'tv'));

      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          movies: safeMovies,
          shows:  safeShows,
        }),
      };
    }

    // ── SUGGEST: multi-source search (title + keyword + genre) ──
    if (action === 'suggest') {
      const query = params.query || '';
      const ANIM = 16;

      // Step 1: Analyze query for implied genres
      const THEME_GENRES = {
        'spy':[28,53],'espionage':[28,53],'secret agent':[28,53],'undercover':[28,53],
        'romance':[10749],'romantic':[10749],'love':[10749],'love story':[10749],
        'comedy':[35],'funny':[35],'humor':[35],'laugh':[35],
        'scary':[27],'horror':[27],'creepy':[27],'ghost':[27],'haunted':[27],
        'action':[28],'fight':[28],'chase':[28],'explosion':[28],
        'thriller':[53],'suspense':[53],'tense':[53],
        'war':[10752],'military':[10752],'army':[10752],'soldier':[10752],
        'space':[878],'alien':[878],'robot':[878],'sci-fi':[878],'sci fi':[878],
        'fantasy':[14],'magic':[14],'wizard':[14],'dragon':[14],
        'mystery':[9648],'detective':[9648],'whodunit':[9648],'clue':[9648],
        'western':[37],'cowboy':[37],
        'music':[10402],'musical':[10402],'concert':[10402],'sing':[10402],
        'family':[10751],'kids':[10751],
        'adventure':[12],'quest':[12],'journey':[12],'treasure':[12],
        'crime':[80],'heist':[80],'mob':[80],'mafia':[80],'gangster':[80],
        'history':[36],'historical':[36],'period':[36],
        'documentary':[99],'doc':[99],
        'superhero':[28,878],'comic book':[28,878],
        'pirate':[12,28],'zombie':[27],'vampire':[27,14],
        'sports':[18],'boxing':[18],'football':[18],'baseball':[18],'soccer':[18],
      };
      const qLow = query.toLowerCase();
      const impliedGenres = new Set();
      const matchedThemes = [];
      for (const [term, gids] of Object.entries(THEME_GENRES)) {
        if (qLow.includes(term)) {
          gids.forEach(g => impliedGenres.add(g));
          matchedThemes.push(term);
        }
      }
      const genreArr = [...impliedGenres];
      const genreParam = genreArr.join('%7C');
      const themeLabel = matchedThemes.length
        ? matchedThemes.map(t => t[0].toUpperCase() + t.slice(1)).join(' ')
        : query;

      const range = eraRanges[era];
      const eraMovieFilter = range
        ? `&primary_release_date.gte=${range.gte}&primary_release_date.lte=${range.lte}` : '';
      const eraTvFilter = range
        ? `&first_air_date.gte=${range.gte}&first_air_date.lte=${range.lte}` : '';

      // Step 2: Parallel TMDB queries
      const enc = encodeURIComponent(query);

      // a) Literal title search (movies + TV)
      const pTitleMovies = type !== 'tv'
        ? tmdb(`/search/movie?query=${enc}&include_adult=false&language=en-US&page=1`, KEY)
        : Promise.resolve({ results: [] });
      const pTitleShows = type !== 'movie'
        ? tmdb(`/search/tv?query=${enc}&include_adult=false&language=en-US&page=1`, KEY)
        : Promise.resolve({ results: [] });

      // b) Keyword IDs for thematic discover
      const pKeywords = tmdb(`/search/keyword?query=${enc}&page=1`, KEY);

      // c) Genre-implied discover (movies + TV)
      const pGenreMovies = genreArr.length > 0 && type !== 'tv'
        ? tmdb(`/discover/movie?sort_by=popularity.desc&with_genres=${genreParam}&vote_count.gte=100&include_adult=false&language=en-US&certification_country=US&certification.lte=PG-13${eraMovieFilter}`, KEY)
        : Promise.resolve({ results: [] });
      const pGenreShows = genreArr.length > 0 && type !== 'movie'
        ? tmdb(`/discover/tv?sort_by=popularity.desc&with_genres=${genreParam}&vote_count.gte=50&language=en-US${eraTvFilter}`, KEY)
        : Promise.resolve({ results: [] });

      const [titleMovies, titleShows, kwData, genreMovies, genreShows] =
        await Promise.all([pTitleMovies, pTitleShows, pKeywords, pGenreMovies, pGenreShows]);

      // Keyword discover (sequential — needs keyword IDs from above)
      const kwIds = (kwData.results || []).slice(0, 5).map(k => k.id);
      let kwMovies = { results: [] }, kwShows = { results: [] };
      if (kwIds.length > 0) {
        const kwParam = kwIds.join('%7C');
        const [km, ks] = await Promise.all([
          type !== 'tv'
            ? tmdb(`/discover/movie?sort_by=popularity.desc&with_keywords=${kwParam}&vote_count.gte=100&include_adult=false&language=en-US&certification_country=US&certification.lte=PG-13${eraMovieFilter}`, KEY)
            : Promise.resolve({ results: [] }),
          type !== 'movie'
            ? tmdb(`/discover/tv?sort_by=popularity.desc&with_keywords=${kwParam}&vote_count.gte=50&language=en-US${eraTvFilter}`, KEY)
            : Promise.resolve({ results: [] }),
        ]);
        kwMovies = km; kwShows = ks;
      }

      // Step 3: Merge, rank, deduplicate
      function isValid(m) {
        return !m.adult && m.original_language === 'en' && !(m.genre_ids || []).includes(ANIM);
      }
      function eraOk(dateStr) {
        if (!range) return true;
        const y = parseInt((dateStr || '').slice(0, 4));
        return y >= parseInt(range.gte.slice(0, 4)) && y <= parseInt(range.lte.slice(0, 4));
      }
      function enrichMovie(m, reason) {
        return {
          id: m.id, media_type: 'movie',
          title: m.title || m.name,
          year: (m.release_date || '').slice(0, 4),
          poster: m.poster_path ? `${IMG_BASE}/w342${m.poster_path}` : null,
          genres: (m.genre_ids || []).map(id => GENRE_MAP[id]).filter(Boolean),
          overview: m.overview || '',
          match_reason: reason,
          vote_average: m.vote_average?.toFixed(1) || null,
        };
      }
      function enrichShow(s, reason) {
        return {
          id: s.id, media_type: 'tv',
          title: s.name || s.title,
          year: (s.first_air_date || '').slice(0, 4),
          poster: s.poster_path ? `${IMG_BASE}/w342${s.poster_path}` : null,
          genres: (s.genre_ids || []).map(id => GENRE_MAP[id]).filter(Boolean),
          overview: s.overview || '',
          match_reason: reason,
          vote_average: s.vote_average?.toFixed(1) || null,
        };
      }

      // Movies: title first, then keyword thematic, then genre
      const seenM = new Set();
      const mergedMovies = [];
      for (const m of (titleMovies.results || [])) {
        if (!seenM.has(m.id) && isValid(m) && eraOk(m.release_date)) {
          seenM.add(m.id);
          mergedMovies.push(enrichMovie(m, 'Title match'));
        }
      }
      for (const m of (kwMovies.results || [])) {
        if (!seenM.has(m.id) && isValid(m)) {
          seenM.add(m.id);
          mergedMovies.push(enrichMovie(m, themeLabel + ' (thematic)'));
        }
      }
      for (const m of (genreMovies.results || [])) {
        if (!seenM.has(m.id) && isValid(m)) {
          seenM.add(m.id);
          const gNames = genreArr.map(id => GENRE_MAP[id]).filter(Boolean).join(', ');
          mergedMovies.push(enrichMovie(m, gNames || 'Genre match'));
        }
      }

      // TV: same layering
      const seenT = new Set();
      const mergedShows = [];
      for (const s of (titleShows.results || [])) {
        if (!seenT.has(s.id) && isValid(s) && eraOk(s.first_air_date)) {
          seenT.add(s.id);
          mergedShows.push(enrichShow(s, 'Title match'));
        }
      }
      for (const s of (kwShows.results || [])) {
        if (!seenT.has(s.id) && isValid(s)) {
          seenT.add(s.id);
          mergedShows.push(enrichShow(s, themeLabel + ' (thematic)'));
        }
      }
      for (const s of (genreShows.results || [])) {
        if (!seenT.has(s.id) && isValid(s)) {
          seenT.add(s.id);
          const gNames = genreArr.map(id => GENRE_MAP[id]).filter(Boolean).join(', ');
          mergedShows.push(enrichShow(s, gNames || 'Genre match'));
        }
      }

      // TV: filter TV-MA
      const tvCandidates = mergedShows.slice(0, 20);
      const tvRatings = await Promise.all(
        tvCandidates.map(async s => {
          try {
            const d = await tmdb(`/tv/${s.id}/content_ratings`, KEY);
            const us = (d.results || []).find(r => r.iso_3166_1 === 'US');
            return { s, rating: us?.rating || null };
          } catch { return { s, rating: null }; }
        })
      );
      const safeShows = tvRatings
        .filter(({ rating }) => rating !== 'TV-MA')
        .slice(0, 12)
        .map(({ s }) => s);

      return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          movies: mergedMovies.slice(0, 12),
          shows: safeShows,
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
