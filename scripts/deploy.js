const { ethers } = require("hardhat");

async function main() {
  const signers = await ethers.getSigners();
  const deployer = signers[0];

  console.log("Deploying onchain-settlement with:", deployer.address);

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const sellToken = await MockERC20.deploy("Demo Base", "DBASE");
  await sellToken.waitForDeployment();

  const buyToken = await MockERC20.deploy("Demo Quote", "DQUOTE");
  await buyToken.waitForDeployment();

  const Settlement = await ethers.getContractFactory("OnchainSettlement");
  const settlement = await Settlement.deploy(deployer.address, 30, deployer.address);
  await settlement.waitForDeployment();

  console.log("MockERC20 (sell)  :", await sellToken.getAddress());
  console.log("MockERC20 (buy)   :", await buyToken.getAddress());
  console.log("OnchainSettlement :", await settlement.getAddress());
  console.log("Fee               : 30 bps (0.30%)");

  // The demo seed needs three distinct roles: a maker, a taker and the deployer.
  if (signers.length < 3) {
    console.log("\nNot enough signers for the demo seed, skipping it.");
    return;
  }

  const [, maker, taker] = signers;
  const SELL_AMOUNT = ethers.parseEther("100");
  const BUY_AMOUNT = ethers.parseEther("250");

  console.log("\nSeeding a demo order ...");
  await (await sellToken.mint(maker.address, ethers.parseEther("1000"))).wait();
  await (await buyToken.mint(taker.address, ethers.parseEther("1000"))).wait();

  await (await sellToken.connect(maker).approve(await settlement.getAddress(), ethers.MaxUint256)).wait();
  await (await buyToken.connect(taker).approve(await settlement.getAddress(), ethers.MaxUint256)).wait();

  const expiry = BigInt(Math.floor(Date.now() / 1000)) + 86_400n;
  await (
    await settlement
      .connect(maker)
      .createOrder(
        await sellToken.getAddress(),
        await buyToken.getAddress(),
        SELL_AMOUNT,
        BUY_AMOUNT,
        expiry
      )
  ).wait();

  await (await settlement.connect(taker).fill(1n, ethers.parseEther("40"))).wait();

  const [sellRemaining, buyRemaining] = await settlement.remaining(1n);
  console.log("Order #1 maker   :", maker.address);
  console.log("Order #1 taker   :", taker.address);
  console.log("Remaining sell   :", ethers.formatEther(sellRemaining));
  console.log("Remaining buy    :", ethers.formatEther(buyRemaining));
  console.log("Accrued fee      :", ethers.formatEther(await settlement.accruedFees(await buyToken.getAddress())));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
