f().then((alert) => {
    console.log("returned "+alert);
}); // 1

async function f() {

    let promise = new Promise((resolve, reject) => {
        setTimeout(() => resolve("done!"), 1000);
    });

    await promise; // wait until the promise resolves (*)
}