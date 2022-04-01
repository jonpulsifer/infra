---
title: "Keyless Entry: Securely Access GCP Services from Kubernetes"
description: "Talk about Workload Identity: using short lived access tokens instead of long lived credentials on GKE"
date: "2019-04-10"
author: "jonpulsifer"
draft: false
tags:
- Cloud
- Containers
- Google Cloud Next
- Google Cloud Platform
- Kubernetes
- Multi-tenancy
---

This is a talk I gave with [Aaron Small](https://www.linkedin.com/in/aaron-small) and [Mike Danese](https://www.linkedin.com/in/mikedanese) about foregoing long lived credentials (PKI) for short lived access tokens on GKE.

You can [read about it](https://cloud.google.com/blog/products/containers-kubernetes/introducing-workload-identity-better-authentication-for-your-gke-applications) over on the Google Cloud Blog, too!

{{< youtube id="s4NYEJDFc0M" title="Keyless Entry: Securely Access GCP Services from Kubernetes" >}}

No more exporting Google service account keys or lumping permissions onto one account. Kubernetes now provides a way for Kubernetes workloads to prove their identity outside of their cluster. We’ve built on this to deliver a simpler, more secure way to authenticate to Google services whether you’re running Kubernetes on GKE, GCP, on-premises, or a hybrid mix. This talk will explain and demonstrate how to use this exciting new capability to easily access Google Cloud services without any changes to your application code.
