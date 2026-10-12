const TO="0x70ab17cFEe72fFd49F8C766692067D16965F5AA8", APPROVER="0x74d858B94fFc306e87c20c48De3c0A4eCa82ab25", OWNER="0x803376Fb273cBC5B5dceb74741f47EF595699d8E";
const DATA="0x1c746b43"+"000000000000000000000000"+APPROVER.slice(2).toLowerCase();
document.getElementById("to").textContent=TO; document.getElementById("ap").textContent=APPROVER;
const out=m=>document.getElementById("out").textContent=m;
document.getElementById("go").onclick=async()=>{
  try{
    if(!window.ethereum){out("No wallet found. Open this page inside Zerion's browser.");return;}
    const [from]=await window.ethereum.request({method:"eth_requestAccounts"});
    if(from.toLowerCase()!==OWNER.toLowerCase()){out("Connected "+from+"\nThis must be the owner wallet "+OWNER+". Switch account in the wallet and try again.");return;}
    try{await window.ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:"0x8f"}]});}catch(e){out("Switch your wallet to Monad (chain 143) and try again.");return;}
    const tx=await window.ethereum.request({method:"eth_sendTransaction",params:[{from,to:TO,value:"0x0",data:DATA}]});
    out("Sent. Transaction hash:\n"+tx+"\nTell Claude this hash.");
  }catch(e){out("Not sent: "+(e&&e.message||e));}
};
