import { Ragie } from "ragie";

// const ragie = new Ragie({
//   auth: "tnt_JdgN2vTLRVd_uyxjbRI6iWJYttXGYX9vOsWdSDgOuWloz3MtgcNbvOJ",
// });

// async function run() {
//   const result = await ragie.documents.delete({
//     documentId: "fc99d751-e5dc-4656-875d-c92650c94a4b",
//     async: false,
//     partition: "default",
//   });

//   console.log(result);
// }

// run();


// import { Ragie } from "ragie";

const ragie = new Ragie({
  auth: "tnt_JdgN2vTLRVd_uyxjbRI6iWJYttXGYX9vOsWdSDgOuWloz3MtgcNbvOJ",
});

async function run() {
  const result = await ragie.documents.list({
      filter: "{\"table_name\":\"Funds [Master]\"}",
  
    partition: "default",
  });

  for await (const page of result) {
      console.log(page);
      console.log(page.result.documents[0])
  }
}

run();