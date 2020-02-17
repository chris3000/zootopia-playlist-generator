const functions = require('firebase-functions');

const admin = require('firebase-admin');
let config = require("./config");
let serviceAccount = require(config["firebase-credentials"]["credentials-location"]);
let crypto = require('crypto');
let cryptoSecret = config["firebase-credentials"]["crypto-secret"];
let got = require('got');
let {DateTime} = require("luxon");
let SpotifyWebApi = require('spotify-web-api-node');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: config["firebase-credentials"].databaseUrl
});

let db = admin.firestore();


//--------- Spotify Playlist generation ---------
function getYesterday () {
    let yesterday = DateTime.local()
        .setZone("America/Los_Angeles", { keepLocalTime: false })
        .minus({ days: 1 })
        .set({hour:0, minute: 0, second:0, millisecond:0});
    return yesterday;
}
//run at 3am every morning
exports.createSpotifyPlaylists = functions.pubsub.schedule('0 3 * * *').onRun((context) => {
    return createSpotifyPlaylists();
});

async function createSpotifyPlaylists() {
    let yesterday = getYesterday();
    let yesterdayEnd = yesterday.set({hour:23, minute:59, second:59, millisecond:999});
    return getTracksFromDB(yesterday, yesterdayEnd);
}

async function getTracksFromDB(yesterday, yesterdayEnd) {
    let coll = db.collection('tracks');
    let snapshot = await coll.where('date', '>=', new Date(yesterday.toString())).where('date', '<=', new Date(yesterdayEnd.toString())).get();
    if (!snapshot.empty) {
        let data = [];
        snapshot.forEach(doc => {
            data.push(doc.data());
        });
        console.log('got tracks from db. total: '+data.length);
        await lookUpTracks(data).catch((err) => {
            console.log("error looking up tracks! message: "+err);
        } );
    }
}
function timeout(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


let _spotifyApi = null;
let lastRefresh = 0;
async function getSpotifyApi() {
    if (_spotifyApi === null) {
        _spotifyApi = new SpotifyWebApi({
            clientId: config["spotify-credentials"].clientId,
            clientSecret: config["spotify-credentials"].clientSecret,
            redirectUri: config["spotify-credentials"].redirectUri,
            accessToken: config["spotify-authorization"].accessToken,
            refreshToken: config["spotify-authorization"].refreshToken
        });
    }
    let now = Math.trunc(new Date().valueOf()/1000);
    if (now - lastRefresh > 3600) {
        let tokendata = await _spotifyApi.refreshAccessToken();
        _spotifyApi.setAccessToken(tokendata.body['access_token']);
        lastRefresh = now;
    }
    return _spotifyApi;
}

async function lookUpTracks(data) {
    let spotifyApi = await getSpotifyApi();
    let trackList = [];
    let spotifyLookups = 0;
    let dblookups = 0;
    for (let i = 0; i < data.length; i++) {
        let item = data[i].spotifyId;
        if (item === undefined) {
            item = await lookupTrack(spotifyApi, data[i]);
            await timeout(75);
            if (item != null) {
                item = item.id;
            } else {
                item = null;
            }
            //console.log("got item from spotifyApi: "+item);
            spotifyLookups++;
        } else {
            dblookups ++;
            //console.log("got id from DB: "+item);
        }
        if (item != null) {
            trackList.push(item);
        }
    }
     console.log("complete track list! total: "+trackList.length+" spotify lookups: "+spotifyLookups+", firebase lookups: "+dblookups);
    await createPlaylist(trackList, spotifyApi, true).catch((err) => {
        console.log("something went wrong creating playlist! "+err);
    });
    await createPlaylist(trackList, spotifyApi, false).catch((err) => {
        console.log("something went wrong updating dynamic playlist! "+err);
    });
}

async function lookupTrack(spotifyApi, kzsuTrackData) {
    let trackdata = await spotifyApi.searchTracks('track:' + kzsuTrackData.title + ' artist:' + kzsuTrackData.artist.replace(/&/g, " "));
    let item = trackdata.body.tracks.items;
    if (item != null && item.length > 0) {
        return item[0];
    } else return null;
}

async function createPlaylist(trackIdList, spotifyApi, createNewPlaylist=true) {
    let getMeData = await spotifyApi.getMe();
    let meData = getMeData.body.id;
    let playlistId = "";
    let yesterday = getYesterday();
    if (createNewPlaylist) {
        // Create a private playlist
        let returnedTrack = await spotifyApi.createPlaylist(meData, 'KZSU Zootopia: ' + yesterday.toLocaleString(DateTime.DATE_FULL), {'public': true});
        playlistId = returnedTrack.body.id;
    } else {
        let foundTrack = await spotifyApi.searchPlaylists(config["spotify-authorization"].dynamicPlaylistName);
        let returnedTrack = foundTrack.body.playlists.items;
        if (returnedTrack.length > 0) {
            returnedTrack = returnedTrack[0];
            playlistId = returnedTrack.id;
        }
    }
    let trackIdArray = [];
    for (let i = 0; i < trackIdList.length; i++) {
        trackIdArray.push("spotify:track:"+trackIdList[i]);
    }
    let offset = 0;
    let page = 45;
    while (offset < trackIdArray.length) {
        let amount = (offset+page >= trackIdArray.length)? trackIdArray.length : offset+page;
        let trackIdArraySubset = trackIdArray.slice(offset, amount);
        if (offset == 0) {
            let adddata = await spotifyApi.replaceTracksInPlaylist(playlistId, trackIdArraySubset);
        } else {
            let adddata = await spotifyApi.addTracksToPlaylist(playlistId, trackIdArraySubset);
        }
        //hack to keep from hitting api rate limit
        await timeout(100);
        offset += page;
    }
    console.log('Added tracks to playlist. new playlist? '+createNewPlaylist);
}

//--------- query KZSU for recent tracks and save to database every hour ---------
exports.queryPlayedTracks = functions.pubsub.schedule('every 60 minutes').onRun((context) => {;
    return queryPlayedTracksMain();
});

async function queryPlayedTracksMain() {
    let data = await queryPlayedTracks();
    console.log("playlist array = "+data.length+", last date received="+data[0].date);
    return saveTracksToDB(data);
}

async function queryPlayedTracks() {
    let spotifyApi = await getSpotifyApi();
    let dateRegex = /\(\d\d\d\d\)$/;
    let data = await got.get("http://kzsu.rocks/songs").json();
    for(let i = 0; i < data.length; i++) {
        //get year released and remove it
        let year = dateRegex.exec(data[i].title);
        if (year != null && year.length > 0) {
            data[i]['year'] = parseInt(year[year.length - 1].replace(/[\(\)]/g, ""));
        }
        data[i].title = data[i].title.replace(dateRegex, "").trim();
        //make date an actual date
        let dtLocal = DateTime.local();
        let now = dtLocal.setZone("America/Los_Angeles", { keepLocalTime: false });
        let time = data[i].date.split(":");
        now = now.set({hour:parseInt(time[0]), minute: parseInt(time[1]), second:0, millisecond:0});
        data[i].date = new Date(now.toString());
        let spotifyTrackData = await lookupTrack(spotifyApi, data[i]);
        data[i].spotifyId = (spotifyTrackData == null) ? null : spotifyTrackData.id;
    }
    return data;
}

//recursive function that saves track data to Firebase database
async function saveTracksToDB(zootopiaTracks) {
    let coll = db.collection('tracks');
    for (let i = 0; i < zootopiaTracks.length; i++) {
        let track = zootopiaTracks[i];
        //create unique ID for DB
        let id = crypto.createHmac('sha256', cryptoSecret)
            .update(track.date.toISOString())
            .digest('base64')
            .replace(/\//g, "-");  //slashes are confusing firebase
        let setDoc = await coll.doc(id).set(track);
    }
}

//for local testing
//createSpotifyPlaylists();
//queryPlayedTracksMain();