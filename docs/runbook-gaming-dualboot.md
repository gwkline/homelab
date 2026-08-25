# Gaming desktop dual-boot runbook

Windows + Linux side by side, zero performance overhead (each OS gets the
bare metal). Windows stays for anti-cheat/bot tooling; Linux for Steam/Proton
and everything else.

## 0. Before anything

- [ ] Back up irreplaceable data. Partition resizing is safe when done right
      and catastrophic when not.
- [ ] ~60 GB+ free space to donate to Linux (100 GB+ if games live there)
- [ ] A USB stick (8 GB+)
- [ ] Know your GPU vendor (NVIDIA users: read Step 4 note first)

## 1. Prep Windows (do NOT skip)

1. **BitLocker**: if enabled, suspend it first (`Manage BitLocker` → Suspend)
   or the resized partition may become unbootable. Re-enable after Linux is
   installed.
2. **Disable Fast Startup**: Control Panel → Power Options → "Choose what the
   power buttons do" → uncheck *Turn on fast startup*. Leaving it on corrupts
   shared NTFS drives mounted from Linux.
3. **Shrink C:**: Start → Disk Management → right-click C: → Shrink Volume →
   shrink by your chosen amount. Leave the resulting space **unallocated**
   (don't create a new volume).
4. Note your Windows EFI setup is standard; nothing else needed.

## 2. Pick a distro

| If you want | Pick |
|---|---|
| Console-like gaming appliance, least tinkering | **Bazzite** |
| Normal desktop + great gaming defaults | **Nobara** (Fedora-based) |
| Vanilla, boring, well-documented | **Fedora Workstation** |

All three handle Steam/Proton well. The rest of this guide works unchanged
for any of them.

## 3. Install Linux alongside Windows

1. Flash the ISO to USB (balenaEtcher), boot from it (F12/F11/Esc boot menu)
2. In the installer's disk step:
   - Choose **manual/custom partitioning**, or "install alongside" if offered
   - Target the **free space** from Step 1 — never touch the Windows or EFI
     partitions
   - Accept the default layout (ESP reused automatically; a root ext4/btrfs
     partition is created in the free space)
3. Finish install, reboot, remove USB. A GRUB menu should offer both OSes.
   - If it boots straight into Linux: see Step 5.
   - If it boots straight into Windows: change boot order in BIOS.

## 4. First-boot Linux setup (gaming)

```sh
# NVIDIA GPUs only (AMD/Intel skip this):
# Fedora/Nobara handles it via RPM Fusion; Bazzite ships it preinstalled.
# If Secure Boot is on, accept the MOK enrollment prompt at reboot.

# Steam via Flatpak works everywhere:
flatpak install flathub com.valvesoftware.Steam
```

In Steam: Settings → Compatibility → enable **Steam Play for all other
titles** (Proton). Per-game status lives at https://www.protondb.com —
check recent reports, filter by hardware similar to yours.

Known-good for this build-out:

- **Palworld**: Deck Verified / Gold. Works out of the box; use GE-Proton
  (via ProtonUp-Qt) + DX12 launch flag if you hit stutter.
- **Catan Universe**: Gold. Try Proton Experimental first.
- Kernel-level anticheat titles (Valorant, most CoD): stay on Windows.
  That's what the dual boot is for.

## 5. Make sure GRUB shows Windows

```sh
sudo grub2-mkconfig -o /boot/grub2/grub.cfg     # Fedora/Nobara/Bazzite
```

If Windows isn't listed:

```sh
# Fedora family: enable os-prober then regenerate
sudo grubby --update-kernel=ALL --remove-args="quiet" # optional
echo 'GRUB_DISABLE_OS_PROBER=false' | sudo tee -a /etc/default/grub
sudo grub2-mkconfig -o /boot/grub2/grub.cfg
```

(Ubuntu family: `sudo update-grub` instead.)

## 6. Fix the clock duel

Windows stores RTC as local time; Linux as UTC — switching OSes shifts your
clock by your UTC offset. On the Linux side:

```sh
sudo timedatectl set-local-rtc 1 --adjust-system-clock
```

## 7. Sharing files between OSes

- Best: a third partition/drive formatted **exFAT** — both OSes read/write it
- NTFS partitions work too (read/write via ntfs3 driver), but never hibernate
  Windows and then mount them in Linux
- Don't put Proton game libraries on NTFS; keep them on ext4/btrfs

## Daily usage notes

- Boot menu appears every start; default OS + timeout are configurable in
  GRUB (`/etc/default/grub`, `GRUB_TIMEOUT`, `GRUB_DEFAULT`)
- Major Windows feature updates occasionally stomp GRUB — if that happens,
  boot the Linux USB into rescue mode and re-run the mkconfig command
- Performance parity is real: same metal, same drivers' access, no VM layer
