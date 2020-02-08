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
    let yesterday = getYesterday();
    let yesterdayEnd = yesterday.set({hour:23, minute:59, second:59, millisecond:999});
    return getTracksFromDB(yesterday, yesterdayEnd);
});

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
async function lookUpTracks(data) {
    let spotifyApi = new SpotifyWebApi({
        clientId: config["spotify-credentials"].clientId,
        clientSecret: config["spotify-credentials"].clientSecret,
        redirectUri: config["spotify-credentials"].redirectUri,
        accessToken: config["spotify-authorization"].accessToken,
        refreshToken: config["spotify-authorization"].refreshToken
    });

    let tokendata = await spotifyApi.refreshAccessToken();
  //  console.log("got token data. "+JSON.stringify(tokendata));
    // Save the access token so that it's used in future calls
    spotifyApi.setAccessToken(tokendata.body['access_token']);
    let trackList = [];
    for (let i = 0; i < data.length; i++) {
        let trackdata = await
            spotifyApi.searchTracks('track:' + data[i].title + ' artist:' + data[i].artist.replace(/&/g, " "));
        let item = trackdata.body.tracks.items;
        if (item != null && item.length > 0) {
            let track = item[0];
            trackList.push(track);
           // console.log('returned track: ' + track.name + ", id:" + track.id + " url:" + track.external_urls.spotify);
            //hack to keep rate limited
            await timeout(75);
        }
    }
     console.log("complete track list! total: "+trackList.length);
    await createPlaylist(trackList, spotifyApi, true).catch((err) => {
        console.log("something went wrong creating playlist! "+err);
    });
    await createPlaylist(trackList, spotifyApi, false).catch((err) => {
        console.log("something went wrong updating dynamic playlist! "+err);
    });
}

async function createPlaylist(trackList, spotifyApi, createNewPlaylist=true) {
    let getMeData = await spotifyApi.getMe();
    let meData = getMeData.body.id;
    let playlistId = "";
    let yesterday = getYesterday();
    if (createNewPlaylist) {
        // Create a private playlist
        let returnedTrack = await spotifyApi.createPlaylist(meData, 'KZSU Zootopia: ' + yesterday.toLocaleString(DateTime.DATE_FULL), {'public': false});
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
    for (let i = 0; i < trackList.length; i++) {
        trackIdArray.push("spotify:track:"+trackList[i].id);
    }
    let offset = 0;
    let page = 50;
    while (offset < trackIdArray.length) {
        let amount = (offset+page >= trackIdArray.length)? trackIdArray.length : offset+page;
        let trackIdArraySubset = trackIdArray.slice(offset, amount);
        if (offset == 0) {
            let adddata = await spotifyApi.replaceTracksInPlaylist(playlistId, trackIdArraySubset);
        } else {
            let adddata = await spotifyApi.addTracksToPlaylist(playlistId, trackIdArraySubset);
        }
        //hack to keep from hitting api rate limit
        await timeout(75);
        offset += page;
    }
    console.log('Added tracks to playlist. new playlist? '+createNewPlaylist);
}

//--------- query KZSU for recent tracks and save to database every hour ---------
exports.queryPlayedTracks = functions.pubsub.schedule('every 60 minutes').onRun((context) => {
    let dateRegex = /\(\d\d\d\d\)$/;
    got.get("http://kzsu.rocks/songs").json().then(function (data) {
            //fix data
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
            }
            console.log("playlist array = "+data.length+", last date received="+data[0].date);
            saveTracksToDB(data, 0);
            return null
        },
        function (err) {
            console.log('Something went wrong!', err);
            return null;
        });
});

//recursive function that saves track data to Firebase database
function saveTracksToDB(zootopiaTracks, index) {
    if (zootopiaTracks.length <= index) {
        return;
    } else {
        let track = zootopiaTracks[index];
        let coll = db.collection('tracks');
        //create unique ID for DB
        let id = crypto.createHmac('sha256', cryptoSecret)
            .update(track.date.toISOString())
            .digest('base64')
            .replace(/\//g, "-");  //slashes are confusing firebase
        let setDoc = coll.doc(id).set(track);
        saveTracksToDB(zootopiaTracks, index+1);
    }
}



